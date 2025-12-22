'use client';

import { useState, useMemo, useCallback } from 'react';
import { MermaidDiagram } from './MermaidDiagram';
import { RiskBadge } from './RiskBadge';
import { DataTable } from './DataTable';
import { RelationshipExplorer } from './RelationshipExplorer';
import { JsonViewer } from './JsonViewer';

interface Column {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
}

interface ForeignKey {
  constraint_name: string;
  source_schema: string;
  source_table: string;
  source_columns: string[];
  target_schema: string;
  target_table: string;
  target_columns: string[];
}

interface Table {
  schema_name: string;
  table_name: string;
  columns: Column[];
  estimated_row_count: number | null;
}

interface SchemaGraph {
  tables: Table[];
  foreign_keys: ForeignKey[];
}

interface SchemaExplorerProps {
  dumpId: string;
  schemaGraph: SchemaGraph;
  fullMermaidER: string;
  selectedDatabase?: string;
}

type ViewMode = 'tables' | 'relationships' | 'columns' | 'table-detail' | 'data';

// Compute parent/child relationships for each table
function computeTableRelations(tables: Table[], foreignKeys: ForeignKey[]) {
  const relations: Record<string, { parents: string[]; children: string[] }> = {};
  
  for (const table of tables) {
    const key = `${table.schema_name}.${table.table_name}`;
    relations[key] = { parents: [], children: [] };
  }
  
  for (const fk of foreignKeys) {
    const sourceKey = `${fk.source_schema}.${fk.source_table}`;
    const targetKey = `${fk.target_schema}.${fk.target_table}`;
    
    if (relations[sourceKey]) {
      relations[sourceKey].parents.push(targetKey);
    }
    if (relations[targetKey]) {
      relations[targetKey].children.push(sourceKey);
    }
  }
  
  return relations;
}

// Generate Mermaid ER for a single table and its relations
function generateTableRelationshipER(
  table: Table,
  allTables: Table[],
  foreignKeys: ForeignKey[],
  degrees: number
): string {
  const tableKey = `${table.schema_name}.${table.table_name}`;
  const includedTables = new Set<string>([tableKey]);
  const includedFKs = new Set<string>();
  
  // BFS to find tables within N degrees
  let currentLevel = new Set<string>([tableKey]);
  
  for (let d = 0; d < degrees; d++) {
    const nextLevel = new Set<string>();
    
    for (const key of Array.from(currentLevel)) {
      const [schema, tbl] = key.split('.');
      
      for (const fk of foreignKeys) {
        const sourceKey = `${fk.source_schema}.${fk.source_table}`;
        const targetKey = `${fk.target_schema}.${fk.target_table}`;
        
        if (sourceKey === key && !includedTables.has(targetKey)) {
          includedTables.add(targetKey);
          nextLevel.add(targetKey);
          includedFKs.add(fk.constraint_name);
        }
        if (targetKey === key && !includedTables.has(sourceKey)) {
          includedTables.add(sourceKey);
          nextLevel.add(sourceKey);
          includedFKs.add(fk.constraint_name);
        }
      }
    }
    
    currentLevel = nextLevel;
  }
  
  // Also include FKs between already included tables
  for (const fk of foreignKeys) {
    const sourceKey = `${fk.source_schema}.${fk.source_table}`;
    const targetKey = `${fk.target_schema}.${fk.target_table}`;
    if (includedTables.has(sourceKey) && includedTables.has(targetKey)) {
      includedFKs.add(fk.constraint_name);
    }
  }
  
  // Generate Mermaid
  let output = 'erDiagram\n';
  
  for (const key of Array.from(includedTables)) {
    const [schema, tbl] = key.split('.');
    const tableInfo = allTables.find(t => t.schema_name === schema && t.table_name === tbl);
    if (!tableInfo) continue;
    
    const safeName = `${schema}_${tbl}`.replace(/-/g, '_');
    const isCenter = key === tableKey;
    
    output += `    ${safeName} {\n`;
    // Show max 15 columns to keep diagram readable
    const columnsToShow = tableInfo.columns.slice(0, 15);
    for (const col of columnsToShow) {
      const pkMarker = col.is_primary_key ? ' PK' : '';
      // Sanitize data type for Mermaid (only alphanumeric and underscore)
      let dataType = col.data_type
        .replace(/\s+/g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '')
        .substring(0, 25) || 'unknown';
      // Sanitize column name (only alphanumeric and underscore)
      const colName = col.name.replace(/[^a-zA-Z0-9_]/g, '_') || 'col';
      output += `        ${dataType} ${colName}${pkMarker}\n`;
    }
    output += '    }\n';
  }
  
  for (const fk of foreignKeys) {
    if (!includedFKs.has(fk.constraint_name)) continue;
    const source = `${fk.source_schema}_${fk.source_table}`.replace(/-/g, '_');
    const target = `${fk.target_schema}_${fk.target_table}`.replace(/-/g, '_');
    output += `    ${target} ||--o{ ${source} : "${fk.source_columns[0] || ''}"\n`;
  }
  
  return output;
}

export function SchemaExplorer({ dumpId, schemaGraph, fullMermaidER, selectedDatabase }: SchemaExplorerProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('tables');
  const [selectedSchema, setSelectedSchema] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<Table | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [relationDegrees, setRelationDegrees] = useState(1);
  
  // State for relationship explorer
  const [relationshipExplorer, setRelationshipExplorer] = useState<{
    isOpen: boolean;
    column: string;
    value: unknown;
  }>({ isOpen: false, column: '', value: null });

  // State for JSON viewer
  const [jsonViewer, setJsonViewer] = useState<{
    isOpen: boolean;
    column: string;
    value: unknown;
  }>({ isOpen: false, column: '', value: null });

  // Check if value is JSON
  const isJsonValue = useCallback((val: unknown): boolean => {
    if (typeof val === 'object' && val !== null) return true;
    if (typeof val === 'string') {
      try {
        JSON.parse(val);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }, []);

  // Handle cell click in DataTable
  const handleCellClick = useCallback((column: string, value: unknown) => {
    if (selectedTable) {
      // If value is JSON, open JSON viewer instead of relationship explorer
      if (isJsonValue(value)) {
        setJsonViewer({
          isOpen: true,
          column,
          value,
        });
      } else {
        setRelationshipExplorer({
          isOpen: true,
          column,
          value,
        });
      }
    }
  }, [selectedTable, isJsonValue]);

  // Get unique schemas with table counts
  const schemas = useMemo(() => {
    const schemaMap: Record<string, { count: number; columns: number; tables: Table[] }> = {};
    for (const table of schemaGraph.tables) {
      if (!schemaMap[table.schema_name]) {
        schemaMap[table.schema_name] = { count: 0, columns: 0, tables: [] };
      }
      schemaMap[table.schema_name].count++;
      schemaMap[table.schema_name].columns += table.columns.length;
      schemaMap[table.schema_name].tables.push(table);
    }
    return Object.entries(schemaMap)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schemaGraph.tables]);

  // Compute relations
  const tableRelations = useMemo(
    () => computeTableRelations(schemaGraph.tables, schemaGraph.foreign_keys),
    [schemaGraph]
  );

  // Filter tables by schema and search
  const filteredTables = useMemo(() => {
    let tables = schemaGraph.tables;
    if (selectedSchema) {
      tables = tables.filter(t => t.schema_name === selectedSchema);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tables = tables.filter(t => 
        t.table_name.toLowerCase().includes(q) ||
        t.schema_name.toLowerCase().includes(q) ||
        t.columns.some(c => c.name.toLowerCase().includes(q))
      );
    }
    return tables;
  }, [schemaGraph.tables, selectedSchema, searchQuery]);

  // All columns for columns view
  const allColumns = useMemo(() => {
    const columns: Array<{ schema: string; table: string; column: Column }> = [];
    for (const table of filteredTables) {
      for (const col of table.columns) {
        columns.push({ schema: table.schema_name, table: table.table_name, column: col });
      }
    }
    return columns;
  }, [filteredTables]);

  // Generate ER for selected table
  const tableER = useMemo(() => {
    if (!selectedTable) return '';
    return generateTableRelationshipER(
      selectedTable,
      schemaGraph.tables,
      schemaGraph.foreign_keys,
      relationDegrees
    );
  }, [selectedTable, schemaGraph, relationDegrees]);

  const handleTableClick = useCallback((table: Table) => {
    setSelectedTable(table);
    setViewMode('table-detail');
  }, []);

  const getTableRelation = (table: Table) => {
    const key = `${table.schema_name}.${table.table_name}`;
    return tableRelations[key] || { parents: [], children: [] };
  };

  // Stats
  const stats = useMemo(() => ({
    tables: schemaGraph.tables.length,
    columns: schemaGraph.tables.reduce((sum, t) => sum + t.columns.length, 0),
    foreignKeys: schemaGraph.foreign_keys.length,
    schemas: schemas.length,
  }), [schemaGraph, schemas]);

  return (
    <div className="space-y-4">

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-gradient-to-br from-indigo-50 to-white dark:from-slate-800 dark:to-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{stats.tables}</div>
          <div className="text-sm text-slate-600 dark:text-slate-400">Tables</div>
        </div>
        <div className="bg-gradient-to-br from-emerald-50 to-white dark:from-slate-800 dark:to-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats.columns}</div>
          <div className="text-sm text-slate-600 dark:text-slate-400">Columns</div>
        </div>
        <div className="bg-gradient-to-br from-amber-50 to-white dark:from-slate-800 dark:to-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats.foreignKeys}</div>
          <div className="text-sm text-slate-600 dark:text-slate-400">Relations</div>
        </div>
        <div className="bg-gradient-to-br from-purple-50 to-white dark:from-slate-800 dark:to-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
          <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.schemas}</div>
          <div className="text-sm text-slate-600 dark:text-slate-400">Schemas</div>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Schema Filter */}
          <select
            value={selectedSchema || ''}
            onChange={(e) => setSelectedSchema(e.target.value || null)}
            className="px-3 py-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm"
          >
            <option value="">All Schemas</option>
            {schemas.map((schema) => (
              <option key={schema.name} value={schema.name}>
                {schema.name} ({schema.count})
              </option>
            ))}
          </select>

          {/* Search */}
          <div className="flex-1 min-w-[200px]">
            <input
              type="text"
              placeholder="🔍 Search tables or columns..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white placeholder-slate-400 text-sm"
            />
          </div>

          {/* View Mode Toggle */}
          <div className="flex bg-slate-100 dark:bg-slate-700 rounded-lg p-1">
            {[
              { id: 'tables', icon: '📋', label: 'Tables' },
              { id: 'columns', icon: '📊', label: 'Columns' },
              { id: 'relationships', icon: '🔗', label: 'Relations' },
              { id: 'data', icon: '🗃️', label: 'Data' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setViewMode(tab.id as ViewMode)}
                className={`px-3 py-1.5 text-sm rounded-md transition-all ${
                  viewMode === tab.id || (viewMode === 'table-detail' && tab.id === 'tables')
                    ? 'bg-white dark:bg-slate-600 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <span className="mr-1">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">

          {/* Tables View */}
          {viewMode === 'tables' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Schema</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Table</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Children</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Parents</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Columns</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Rows</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTables.map((table) => {
                    const rel = getTableRelation(table);
                    return (
                      <tr
                        key={`${table.schema_name}.${table.table_name}`}
                        onClick={() => handleTableClick(table)}
                        className="border-b border-slate-100 dark:border-slate-700/50 hover:bg-slate-50 dark:hover:bg-slate-700/50 cursor-pointer transition-colors"
                      >
                        <td className="py-3 px-4">
                          <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs font-mono text-slate-600 dark:text-slate-400">
                            {table.schema_name}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-medium text-indigo-600 dark:text-indigo-400 hover:underline">
                          {table.table_name}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {rel.children.length > 0 ? (
                            <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded-full text-xs">
                              {rel.children.length}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {rel.parents.length > 0 ? (
                            <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded-full text-xs">
                              {rel.parents.length}
                            </span>
                          ) : (
                            <span className="text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-center text-slate-600 dark:text-slate-400">
                          {table.columns.length}
                        </td>
                        <td className="py-3 px-4 text-center text-slate-600 dark:text-slate-400">
                          {table.estimated_row_count?.toLocaleString() || '-'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                Showing {filteredTables.length} of {schemaGraph.tables.length} tables
              </div>
            </div>
          )}

          {/* Table Detail View */}
          {viewMode === 'table-detail' && selectedTable && (
            <div className="space-y-6">
              {/* Breadcrumb & Header */}
              <div className="flex items-center justify-between">
                <div>
                  <button
                    onClick={() => setViewMode('tables')}
                    className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline mb-2 flex items-center gap-1"
                  >
                    ← Back to Tables
                  </button>
                  <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                    <span className="text-slate-400 font-normal">{selectedTable.schema_name}.</span>
                    {selectedTable.table_name}
                  </h2>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                    {selectedTable.columns.length} columns · {selectedTable.estimated_row_count?.toLocaleString() || 0} rows (estimated)
                  </p>
                </div>
                <RiskBadge 
                  dumpId={dumpId} 
                  schema={selectedTable.schema_name} 
                  table={selectedTable.table_name} 
                />
              </div>

              {/* Columns */}
              <div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-3">Columns</h3>
                <div className="overflow-x-auto border border-slate-200 dark:border-slate-700 rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800">
                      <tr>
                        <th className="text-left py-2 px-4 font-medium text-slate-600 dark:text-slate-400">Column</th>
                        <th className="text-left py-2 px-4 font-medium text-slate-600 dark:text-slate-400">Type</th>
                        <th className="text-center py-2 px-4 font-medium text-slate-600 dark:text-slate-400">Nullable</th>
                        <th className="text-left py-2 px-4 font-medium text-slate-600 dark:text-slate-400">Default</th>
                        <th className="text-left py-2 px-4 font-medium text-slate-600 dark:text-slate-400">Constraints</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedTable.columns.map((col) => (
                        <tr key={col.name} className="border-t border-slate-200 dark:border-slate-700">
                          <td className="py-2 px-4 font-mono text-slate-900 dark:text-white">
                            {col.name}
                          </td>
                          <td className="py-2 px-4 font-mono text-slate-600 dark:text-slate-400 text-xs">
                            {col.data_type}
                          </td>
                          <td className="py-2 px-4 text-center">
                            {col.is_nullable ? (
                              <span className="text-slate-400">✓</span>
                            ) : (
                              <span className="text-amber-600 dark:text-amber-400 font-medium">NOT NULL</span>
                            )}
                          </td>
                          <td className="py-2 px-4 font-mono text-xs text-slate-500 dark:text-slate-400">
                            {col.default_value || '-'}
                          </td>
                          <td className="py-2 px-4">
                            {col.is_primary_key && (
                              <span className="px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded text-xs font-medium">
                                PRIMARY KEY
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Relationships */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white">Relationships</h3>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-500">Degrees:</span>
                    {[1, 2, 3].map((d) => (
                      <button
                        key={d}
                        onClick={() => setRelationDegrees(d)}
                        className={`px-3 py-1 text-sm rounded ${
                          relationDegrees === d
                            ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400'
                            : 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
                        }`}
                      >
                        {d}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Parent/Child tables */}
                <div className="grid md:grid-cols-2 gap-4 mb-4">
                  <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
                    <h4 className="font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
                      <span className="text-blue-500">↑</span> Parent Tables (references)
                    </h4>
                    {getTableRelation(selectedTable).parents.length > 0 ? (
                      <ul className="space-y-1">
                        {getTableRelation(selectedTable).parents.map((p) => (
                          <li key={p}>
                            <button
                              onClick={() => {
                                const [schema, table] = p.split('.');
                                const t = schemaGraph.tables.find(t => t.schema_name === schema && t.table_name === table);
                                if (t) handleTableClick(t);
                              }}
                              className="text-indigo-600 dark:text-indigo-400 hover:underline text-sm font-mono"
                            >
                              {p}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-400">No parent tables</p>
                    )}
                  </div>
                  <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-4">
                    <h4 className="font-medium text-slate-900 dark:text-white mb-2 flex items-center gap-2">
                      <span className="text-green-500">↓</span> Child Tables (referenced by)
                    </h4>
                    {getTableRelation(selectedTable).children.length > 0 ? (
                      <ul className="space-y-1">
                        {getTableRelation(selectedTable).children.map((c) => (
                          <li key={c}>
                            <button
                              onClick={() => {
                                const [schema, table] = c.split('.');
                                const t = schemaGraph.tables.find(t => t.schema_name === schema && t.table_name === table);
                                if (t) handleTableClick(t);
                              }}
                              className="text-indigo-600 dark:text-indigo-400 hover:underline text-sm font-mono"
                            >
                              {c}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-400">No child tables</p>
                    )}
                  </div>
                </div>

                {/* ER Diagram for this table */}
                {tableER && (
                  <MermaidDiagram chart={tableER} className="border border-slate-200 dark:border-slate-700 rounded-lg" />
                )}
              </div>
            </div>
          )}

          {/* Columns View */}
          {viewMode === 'columns' && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-700">
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Schema</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Table</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Column</th>
                    <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Type</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Nullable</th>
                    <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">PK</th>
                  </tr>
                </thead>
                <tbody>
                  {allColumns.slice(0, 200).map((item, idx) => (
                    <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50">
                      <td className="py-2 px-4">
                        <span className="px-2 py-0.5 bg-slate-100 dark:bg-slate-700 rounded text-xs font-mono">
                          {item.schema}
                        </span>
                      </td>
                      <td className="py-2 px-4">
                        <button
                          onClick={() => {
                            const t = schemaGraph.tables.find(t => t.schema_name === item.schema && t.table_name === item.table);
                            if (t) handleTableClick(t);
                          }}
                          className="text-indigo-600 dark:text-indigo-400 hover:underline font-mono text-sm"
                        >
                          {item.table}
                        </button>
                      </td>
                      <td className="py-2 px-4 font-mono text-slate-900 dark:text-white">{item.column.name}</td>
                      <td className="py-2 px-4 font-mono text-xs text-slate-500 dark:text-slate-400">{item.column.data_type}</td>
                      <td className="py-2 px-4 text-center">
                        {item.column.is_nullable ? <span className="text-slate-400">✓</span> : <span className="text-slate-400">-</span>}
                      </td>
                      <td className="py-2 px-4 text-center">
                        {item.column.is_primary_key && (
                          <span className="px-1.5 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded text-xs">PK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {allColumns.length > 200 && (
                <div className="mt-2 text-xs text-slate-500">
                  Showing 200 of {allColumns.length} columns. Use search to filter.
                </div>
              )}
            </div>
          )}

          {/* Relationships View */}
          {viewMode === 'relationships' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  {schemaGraph.foreign_keys.length} foreign key relationships
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 dark:border-slate-700">
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Child Table</th>
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Column</th>
                      <th className="text-center py-3 px-4 font-semibold text-slate-700 dark:text-slate-300"></th>
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Parent Table</th>
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Column</th>
                      <th className="text-left py-3 px-4 font-semibold text-slate-700 dark:text-slate-300">Constraint</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schemaGraph.foreign_keys
                      .filter(fk => !selectedSchema || fk.source_schema === selectedSchema || fk.target_schema === selectedSchema)
                      .slice(0, 100)
                      .map((fk, idx) => (
                      <tr key={idx} className="border-b border-slate-100 dark:border-slate-700/50">
                        <td className="py-2 px-4">
                          <button
                            onClick={() => {
                              const t = schemaGraph.tables.find(t => t.schema_name === fk.source_schema && t.table_name === fk.source_table);
                              if (t) handleTableClick(t);
                            }}
                            className="text-indigo-600 dark:text-indigo-400 hover:underline font-mono text-sm"
                          >
                            <span className="text-slate-400">{fk.source_schema}.</span>
                            {fk.source_table}
                          </button>
                        </td>
                        <td className="py-2 px-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                          {fk.source_columns.join(', ')}
                        </td>
                        <td className="py-2 px-4 text-center text-slate-400">→</td>
                        <td className="py-2 px-4">
                          <button
                            onClick={() => {
                              const t = schemaGraph.tables.find(t => t.schema_name === fk.target_schema && t.table_name === fk.target_table);
                              if (t) handleTableClick(t);
                            }}
                            className="text-indigo-600 dark:text-indigo-400 hover:underline font-mono text-sm"
                          >
                            <span className="text-slate-400">{fk.target_schema}.</span>
                            {fk.target_table}
                          </button>
                        </td>
                        <td className="py-2 px-4 font-mono text-xs text-slate-600 dark:text-slate-400">
                          {fk.target_columns.join(', ')}
                        </td>
                        <td className="py-2 px-4 font-mono text-xs text-slate-500 dark:text-slate-500">
                          {fk.constraint_name}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Data Explorer View */}
          {viewMode === 'data' && (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <select
                  value={selectedTable ? `${selectedTable.schema_name}.${selectedTable.table_name}` : ''}
                  onChange={(e) => {
                    const [schema, table] = e.target.value.split('.');
                    const t = schemaGraph.tables.find(t => t.schema_name === schema && t.table_name === table);
                    if (t) setSelectedTable(t);
                  }}
                  className="px-4 py-2 border border-slate-200 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white"
                >
                  <option value="">Select a table...</option>
                  {filteredTables.map((table) => (
                    <option key={`${table.schema_name}.${table.table_name}`} value={`${table.schema_name}.${table.table_name}`}>
                      {table.schema_name}.{table.table_name}
                    </option>
                  ))}
                </select>
              </div>
              {selectedTable ? (
                <>
                  <div className="mb-4 p-3 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg border border-indigo-200 dark:border-indigo-800">
                    <p className="text-sm text-indigo-700 dark:text-indigo-300">
                      💡 <strong>Tip:</strong> Click any cell to explore relationships or view formatted JSON
                    </p>
                  </div>
                  <DataTable 
                    dumpId={dumpId} 
                    schema={selectedTable.schema_name} 
                    table={selectedTable.table_name} 
                    database={selectedDatabase}
                    onCellClick={handleCellClick}
                  />
                </>
              ) : (
                <p className="text-center py-8 text-slate-500 dark:text-slate-400">
                  Select a table to view its data
                </p>
              )}
            </div>
          )}
      </div>

      {/* Relationship Explorer Modal */}
      {selectedTable && (
        <RelationshipExplorer
          isOpen={relationshipExplorer.isOpen}
          onClose={() => setRelationshipExplorer({ isOpen: false, column: '', value: null })}
          dumpId={dumpId}
          schema={selectedTable.schema_name}
          table={selectedTable.table_name}
          column={relationshipExplorer.column}
          value={relationshipExplorer.value}
        />
      )}

      {/* JSON Viewer Modal */}
      {selectedTable && (
        <JsonViewer
          isOpen={jsonViewer.isOpen}
          onClose={() => setJsonViewer({ isOpen: false, column: '', value: null })}
          schema={selectedTable.schema_name}
          table={selectedTable.table_name}
          column={jsonViewer.column}
          value={jsonViewer.value}
        />
      )}
    </div>
  );
}
