# PgDumpLens ユーザーガイド

このガイドでは、PgDumpLensの主要機能の使い方を順を追って説明します。

## 📚 目次

1. [ダンプファイルのアップロード](#1-ダンプファイルのアップロード)
2. [スキーマエクスプローラー](#2-スキーマエクスプローラー)
3. [リレーションシップエクスプローラー](#3-リレーションシップエクスプローラー)
4. [全文検索機能](#4-全文検索機能)
5. [JSONビューアー](#5-jsonビューアー)
6. [リスク評価の見方](#6-リスク評価の見方)
7. [マルチデータベース対応](#7-マルチデータベース対応)
8. [ダンプの削除](#8-ダンプの削除)

---

## 1. ダンプファイルのアップロード

### 対応フォーマット

PgDumpLensは以下のPostgreSQLダンプファイルに対応しています：

| 形式           | コマンド例                              | ファイル拡張子      |
| -------------- | --------------------------------------- | ------------------- |
| **Plain SQL**  | `pg_dump -Fp database_name > dump.sql`  | `.sql`              |
| **Custom形式** | `pg_dump -Fc database_name > dump.dump` | `.dump`, `.backup`  |
| **Gzip圧縮**   | `pg_dump -Fp database_name              | gzip > dump.sql.gz` | `.sql.gz`, `.dump.gz` |
| **pg_dumpall** | `pg_dumpall > all_databases.sql`        | `.sql`              |

> **💡 Tips**: ファイル拡張子は不問です。マジックバイトで自動判別されます。

### アップロード手順

#### 方法1: Webブラウザから

1. **ホームページにアクセス**

   ```text
   http://localhost:3000
   ```

2. **「Upload New Dump」をクリック**

3. **ファイルを選択**
   - ドラッグ&ドロップ
   - または「Browse files」をクリックしてファイル選択

4. **ダンプ名を入力（オプション）**

   ```text
   例: Production DB Backup 2025-12-22
   ```

5. **「Upload & Analyze」をクリック**

#### 方法2: コマンドラインから（CLI）

**Linux/Mac:**

```bash
./scripts/upload-dump.sh ./backup.sql "My Database" http://localhost:8080
```

**Windows (PowerShell):**

```powershell
.\scripts\upload-dump.ps1 -DumpFile .\backup.sql -Name "My Database" -ServerUrl http://localhost:8080
```

### 処理の流れ

アップロード後、以下の処理が自動で実行されます：

```mermaid
graph LR
    A[アップロード] --> B[ファイル保存]
    B --> C[サンドボックスDBに復元]
    C --> D[スキーマ解析]
    D --> E[外部キー取得]
    E --> F[リスク評価]
    F --> G[完了]
```

⏱️ **処理時間の目安**:

- 小規模DB（< 100テーブル）: 10-30秒
- 中規模DB（100-500テーブル）: 30秒-2分
- 大規模DB（> 500テーブル）: 2-10分

---

## 2. スキーマエクスプローラー

ダンプの解析が完了すると、スキーマエクスプローラーが表示されます。

### 主な機能

#### 📊 ER図（Entity Relationship Diagram）

**表示方法**: ページ上部の「ER Diagram」タブをクリック

```
┌─────────────┐       ┌──────────────┐       ┌────────────┐
│   users     │───────│   orders     │───────│order_items │
│─────────────│       │──────────────│       │────────────│
│ id (PK)     │1     N│ id (PK)      │1     N│ id (PK)    │
│ email       │       │ user_id (FK) │       │ order_id   │
│ name        │       │ total        │       │ product_id │
└─────────────┘       └──────────────┘       └────────────┘
```

**機能**:

- 🔍 ズームイン/アウト
- 📋 Mermaidコードをコピー可能

#### 🔍 テーブル検索

**使い方**:

1. 検索ボックスにテーブル名やカラム名を入力
2. リアルタイムでフィルタリング

```
🔍 [user___________]
   ↓ 3件ヒット
   • users
   • user_profiles
   • user_sessions
```

#### 📋 テーブル一覧

各テーブルには以下の情報が表示されます：

| 項目           | 説明                  | 表示例                             |
| -------------- | --------------------- | ---------------------------------- |
| **テーブル名** | スキーマ名.テーブル名 | `public.users`                     |
| **行数**       | 推定行数              | `1.2K rows`                        |
| **外部キー**   | 参照関係の数          | `→ 3` (Outbound) / `← 5` (Inbound) |
| **リスク**     | 削除時の影響度        | 🔴 Critical (85/100)                |

#### 📑 カラム詳細

テーブルをクリックすると、カラム情報が展開されます：

```
users (1,234 rows)
├─ id               bigint          PK  NOT NULL
├─ email            varchar(255)        NOT NULL  UNIQUE
├─ name             varchar(100)        NULL
├─ created_at       timestamp           NOT NULL  DEFAULT now()
└─ department_id    integer         FK  → departments.id
```

**アイコンの意味**:

- 🔑 **PK**: Primary Key（主キー）
- 🔗 **FK**: Foreign Key（外部キー）
- ❗ **NOT NULL**: NULL不可
- ⭐ **UNIQUE**: 一意制約

#### 📊 データプレビュー

**表示方法**: 「View Data」ボタンをクリック

**機能**:

- ページネーション（デフォルト: 50行/ページ）
- カラムでソート
- 値のフィルタリング
- セルの値から関連データを探索

---

## 3. リレーションシップエクスプローラー

テーブルデータ内のセルをクリックすると、その値の参照関係を表示します。

### 使い方

1. **データを表示**

   ```
   users テーブルを開く → View Data
   ```

2. **セルをクリック**

   ```
   id = 123 をクリック
   ```

3. **関連情報が表示される**

### 表示内容

#### 🔼 Outbound References（このテーブルから参照している）

```
users.department_id = 5

[Outbound]
👉 departments.id
   • public.departments テーブルを参照
   • JOIN例:
     SELECT * FROM users u
     INNER JOIN departments d ON u.department_id = d.id
     WHERE u.department_id = 5;
```

#### 🔽 Inbound References（他のテーブルから参照されている）

```
users.id = 123

[Inbound]
📥 orders → users (450 rows)
   Risk: 🟠 High (65/100)
   • 450行が参照中
   • DELETE CASCADE設定あり
   • 削除すると関連ordersも削除される

📥 comments → users (28 rows)
   Risk: 🟢 Low (20/100)
   • 28行が参照中
   • 影響範囲は限定的
```

### リスクスコアの意味

| レベル         | スコア | 説明                                |
| -------------- | ------ | ----------------------------------- |
| 🟢 **Low**      | 0-25   | 影響小。安全に変更可能              |
| 🟡 **Medium**   | 26-50  | 中程度の影響。注意が必要            |
| 🟠 **High**     | 51-75  | 広範囲への影響。慎重に              |
| 🔴 **Critical** | 76-100 | 重大な影響。CASCADE連鎖削除の危険性 |

### SQL例の活用

リレーションシップエクスプローラーには、実行可能なSQLクエリのサンプルが表示されます：

```sql
-- 参照元データを取得
SELECT * FROM orders
WHERE user_id = 123
LIMIT 100;

-- JOINして関連データを確認
SELECT 
    u.id,
    u.name,
    o.id as order_id,
    o.total
FROM users u
INNER JOIN orders o ON u.id = o.user_id
WHERE u.id = 123;
```

**💡 Tips**: 右上のコピーボタンでSQLをコピーし、実際のDBで実行できます。

---

## 4. 全文検索機能

データベース全体から特定の値を横断検索できます。

### 使い方

1. **検索タブを開く**

   ```
   ダンプ詳細ページ → 🔍 Full-Text Search タブ
   ```

2. **検索キーワードを入力**

   ```
   例: example.com
       12345
       fd8cadd3-babd-4cda-a7aa-09221a606b20
   ```

3. **検索範囲を指定（オプション）**
   - **All Databases**: 全データベースを検索
   - **特定DB**: ドロップダウンから選択

4. **Search ボタンをクリック または Enter キー**

### 検索結果

#### サマリー情報

```
Found 11 result(s) for "example.com" (searched 181 table(s))
```

#### 各検索結果の詳細

```
┌─────────────────────────────────────────────────────────────┐
│ 📁 domainmanager › public › users › email                   │
├─────────────────────────────────────────────────────────────┤
│ Matched Value:                                              │
│ admin@example.com                                           │
│                                                             │
│ ▼ Show full row data                                       │
│                                                             │
│ SQL to reproduce this search:                               │
│ SELECT * FROM "public"."users"                              │
│ WHERE CAST("email" AS TEXT) ILIKE '%example.com%'          │
│ LIMIT 10;                                                   │
│ [Copy SQL]                                                  │
└─────────────────────────────────────────────────────────────┘
```

**各項目の説明**:

1. **📁 Location Path**
   - データベース名 › スキーマ名 › テーブル名 › カラム名

2. **Matched Value**
   - 検索にマッチした値
   - ハイライト表示

3. **Show full row data**
   - クリックすると行全体のデータをJSON形式で表示
   - 他のカラムの値も確認可能

4. **SQL to reproduce this search**
   - 実際のDBで同じ検索を実行するためのSQLクエリ
   - コピーして直接実行可能

### 検索対象

以下のデータ型のカラムが検索対象です：

- ✅ `TEXT`
- ✅ `VARCHAR`
- ✅ `CHAR`
- ✅ `JSON`
- ✅ `JSONB`

### 検索のコツ

**部分一致検索**:

```
検索: "example"
ヒット: "user@example.com", "example_user", "test_example_123"
```

**UUID検索**:

```
検索: "fd8cadd3-babd-4cda-a7aa-09221a606b20"
完全一致: UUID型でもTEXTとしてキャストして検索
```

**ホスト名検索**:

```
検索: "192.168.1.100"
ヒット: IPアドレス、URL、設定ファイルのホスト名など
```

### 検索結果の活用例

#### 個人情報の棚卸し

```
検索: "john.doe@company.com"
→ メールアドレスがどのテーブルに格納されているか把握
→ GDPR対応のための影響範囲調査
```

#### 設定値の追跡

```
検索: "api.external-service.com"
→ 外部サービスのエンドポイント設定箇所を特定
→ 環境変数への切り出し検討
```

#### データ整合性チェック

```
検索: 削除予定のユーザーID "12345"
→ 参照が残っているテーブルを発見
→ 削除前のクリーンアップ作業に利用
```

---

## 5. JSONビューアー

JSON/JSONB型のカラム値を整形して表示します。

### 起動方法

**データテーブルでJSONセルをクリック**

```
settings テーブル → config カラムの値をクリック
```

### 表示内容

#### メタデータ

```
Type: object
Size: 245 bytes
```

#### 整形されたJSON

```json
{
  "notification": {
    "email": true,
    "push": false,
    "frequency": "daily"
  },
  "theme": {
    "mode": "dark",
    "color": "blue"
  },
  "features": [
    "beta",
    "experimental"
  ]
}
```

### 機能

- 📋 **Copy to Clipboard**: ワンクリックでコピー
- 🎨 **Syntax Highlighting**: 見やすい色分け表示
- 📏 **自動インデント**: 2スペースで整形

### 対応するJSON形式

| 形式            | 例                      | 説明                       |
| --------------- | ----------------------- | -------------------------- |
| **Object**      | `{"key": "value"}`      | JSONオブジェクト           |
| **Array**       | `[1, 2, 3]`             | JSON配列                   |
| **JSON String** | `"{\"key\":\"value\"}"` | エスケープされたJSON文字列 |

> **💡 Tips**: JSON文字列として格納されている場合も自動でパースして表示します。

---

## 6. リスク評価の見方

### テーブルレベルのリスク

**確認方法**: スキーマエクスプローラーのテーブル一覧

```
users                        🔴 Critical (85/100)
├─ 5個のInbound外部キー
├─ 3個のCASCADE削除設定
├─ 10,000行以上の大規模テーブル
└─ 主キーで他テーブルから広く参照されている
```

#### リスクスコアの要因

| 要因                | 配点   | 説明                           |
| ------------------- | ------ | ------------------------------ |
| **Inbound外部キー** | 各10点 | 他テーブルから参照されている数 |
| **CASCADE削除**     | 各15点 | 連鎖削除が発生する外部キー数   |
| **RESTRICT制約**    | 10点   | 削除をブロックする制約         |
| **大規模テーブル**  | 10点   | 10,000行以上                   |
| **主キー参照**      | 10点   | 識別子として使用されている     |

### カラムレベルのリスク

**確認方法**: Relationship Explorerでセルをクリック

```
users.id = 123

Risk: 🟠 High (65/100)

理由:
• 450行が他テーブルから参照中
• 削除するとordersテーブルの行も連鎖削除される
• 主キーカラム
```

#### スコアの基準

| 参照行数    | 配点 |
| ----------- | ---- |
| 1-10行      | 10点 |
| 11-100行    | 20点 |
| 101-1,000行 | 30点 |
| 1,000行以上 | 40点 |

**追加配点**:

- CASCADE外部キー: +20点/個
- 主キー列: +15点

### リスクレベル別の対応指針

#### 🟢 Low (0-25点)

**状況**: 影響範囲が限定的
**対応**: 通常通り作業可能

```sql
-- 例: 参照が少ない補助データの削除
DELETE FROM tags WHERE id = 999;
```

#### 🟡 Medium (26-50点)

**状況**: 中程度の影響
**対応**:

- トランザクション内で実行
- 事前にバックアップ

```sql
BEGIN;
DELETE FROM users WHERE id = 123;
-- 問題なければ
COMMIT;
-- 問題があれば
ROLLBACK;
```

#### 🟠 High (51-75点)

**状況**: 広範囲への影響
**対応**:

- 関連データの事前確認
- 本番前にステージング環境でテスト
- ピーク時間を避ける

```sql
-- 参照元データを確認
SELECT COUNT(*) FROM orders WHERE user_id = 123;
-- 影響範囲を把握してから実行
```

#### 🔴 Critical (76-100点)

**状況**: 重大な影響、連鎖削除の危険性
**対応**:

- 必ずメンテナンスウィンドウで実行
- 完全なバックアップ取得
- DBA承認を得る
- 段階的に削除（まず子レコードから）

```sql
-- ステップ1: 子レコードを確認
SELECT * FROM orders WHERE user_id = 123;

-- ステップ2: 子レコードを手動削除または更新
UPDATE orders SET user_id = NULL WHERE user_id = 123;

-- ステップ3: 親レコードを削除
DELETE FROM users WHERE id = 123;
```

---

## 7. マルチデータベース対応

`pg_dumpall`形式のダンプファイルでは、複数のデータベースを同時に扱えます。

### pg_dumpallダンプの作成

```bash
# 全データベースをダンプ
pg_dumpall > all_databases.sql

# Gzip圧縮版
pg_dumpall | gzip > all_databases.sql.gz
```

### データベースの切り替え

1. **ダンプ詳細ページで確認**

   ```
   Database: [domainmanager (default) ▼]
            5 databases available (pg_dumpall format)
   ```

2. **ドロップダウンから選択**

   ```
   • domainmanager (default)
   • postgres
   • template1
   • analytics
   • logging
   ```

3. **自動的にスキーマが切り替わる**

### 各データベース独立した機能

- ✅ スキーマ表示
- ✅ ER図生成
- ✅ データ検索
- ✅ リスク評価
- ✅ 全文検索（データベース指定可能）

### 全文検索でのデータベース指定

```
🔍 検索ボックス: "example.com"
📁 Database: [All Databases ▼]  または  [domainmanager ▼]
```

**All Databases**: 全データベース横断検索
**特定DB**: そのデータベース内のみ検索

---

## 8. ダンプの削除

不要になったダンプは手動で削除できます。

### 削除方法

1. **ダンプ詳細ページを開く**

2. **「🗑️ Delete」ボタンをクリック**
   - ページ右上に配置

3. **確認ダイアログで「Delete」を再度クリック**

   ```
   Delete Dump?
   This will permanently delete the dump "Production DB" 
   and all associated data. This action cannot be undone.
   
   [Cancel]  [Delete]
   ```

### 削除される内容

- ✅ アップロードされたダンプファイル
- ✅ サンドボックスデータベース
- ✅ スキーマ情報
- ✅ メタデータ（リスク評価結果など）

> **⚠️ 注意**: 削除後は復元できません。

### 自動削除（TTL）

ダンプは一定期間後に自動削除されます：

```
⏰ Expires: 2025-12-29 4:15 PM (7日後)
```

**デフォルト保持期間**: 7日間

**変更方法**:

```bash
# 環境変数で設定（秒単位）
DUMP_TTL_SECONDS=604800  # 7日間
```

---

## 🎓 Tips & Best Practices

### パフォーマンス最適化

1. **大規模ダンプ**
   - 分析完了まで5-10分かかる場合があります
   - ページを閉じても処理は継続されます

2. **検索の効率化**
   - データベースを絞り込んで検索
   - 具体的なキーワードを使用

3. **リスク評価の活用**
   - 作業前に必ず確認
   - Critical評価の操作は慎重に

### セキュリティ

1. **本番データの扱い**
   - 個人情報を含むダンプは注意
   - アクセス制限の設定を推奨

2. **ダンプの削除**
   - 不要になったらすぐに削除
   - TTLを適切に設定

### トラブルシューティング

**問題**: ダンプのアップロードが失敗する
**対応**:

- ファイルサイズを確認（上限: 5GB）
- ダンプファイルの形式を確認

**問題**: スキーマが表示されない
**対応**:

- ブラウザを再読み込み
- ステータスが「READY」になるまで待つ

**問題**: 検索結果が表示されない
**対応**:

- キーワードを変更して再検索
- データベースの選択を確認

---

## 📞 サポート

質問や問題がある場合:

- 📧 Email: <support@example.com>
- 💬 GitHub Issues: <https://github.com/your-username/pgdumplens/issues>
- 📖 Docs: <https://pgdumplens.example.com/docs>

---

**Happy Database Analyzing! 🚀**
