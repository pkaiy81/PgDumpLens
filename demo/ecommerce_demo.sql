--
-- PgDumpLens Demo Database: E-Commerce System
-- This dump demonstrates all major features of PgDumpLens
--
-- Features demonstrated:
--   - ER Diagram visualization (multiple related tables)
--   - Foreign Key relationships (inbound/outbound)
--   - CASCADE delete (risk assessment)
--   - JSON/JSONB columns (JSON viewer)
--   - Full-text search (various data types)
--   - Risk scoring (critical tables)
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET client_min_messages = warning;

--
-- Create schema
--
CREATE SCHEMA IF NOT EXISTS public;

SET search_path = public, pg_catalog;

-- ============================================
-- CORE TABLES
-- ============================================

--
-- Table: users (Critical - referenced by many tables)
--
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(200),
    phone VARCHAR(20),
    avatar_url VARCHAR(500),
    preferences JSONB DEFAULT '{}',
    is_active BOOLEAN DEFAULT true,
    email_verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE users IS 'Core user accounts - HIGH RISK: Referenced by orders, reviews, addresses, cart';
COMMENT ON COLUMN users.preferences IS 'User preferences stored as JSON (theme, notifications, language)';

--
-- Table: categories (Self-referencing for hierarchy)
--
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    display_order INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE categories IS 'Product categories with hierarchical structure';

--
-- Table: products
--
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    price DECIMAL(10, 2) NOT NULL,
    compare_at_price DECIMAL(10, 2),
    cost_price DECIMAL(10, 2),
    stock_quantity INTEGER DEFAULT 0,
    low_stock_threshold INTEGER DEFAULT 10,
    weight_kg DECIMAL(6, 3),
    dimensions JSONB,
    attributes JSONB DEFAULT '{}',
    tags TEXT[],
    is_active BOOLEAN DEFAULT true,
    is_featured BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE products IS 'Product catalog with JSON attributes';
COMMENT ON COLUMN products.dimensions IS 'Product dimensions as JSON: {length, width, height, unit}';
COMMENT ON COLUMN products.attributes IS 'Dynamic product attributes: color, size, material, etc.';

--
-- Table: product_images
--
CREATE TABLE product_images (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    url VARCHAR(500) NOT NULL,
    alt_text VARCHAR(200),
    display_order INTEGER DEFAULT 0,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE product_images IS 'Product images - CASCADE delete when product is removed';

--
-- Table: user_addresses
--
CREATE TABLE user_addresses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label VARCHAR(50) DEFAULT 'Home',
    recipient_name VARCHAR(200) NOT NULL,
    street_address VARCHAR(500) NOT NULL,
    city VARCHAR(100) NOT NULL,
    state VARCHAR(100),
    postal_code VARCHAR(20) NOT NULL,
    country VARCHAR(100) NOT NULL DEFAULT 'Japan',
    phone VARCHAR(20),
    is_default BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE user_addresses IS 'User shipping addresses - CASCADE delete with user';

--
-- Table: orders (Critical - links users and products)
--
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    order_number VARCHAR(50) NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status VARCHAR(50) DEFAULT 'pending',
    subtotal DECIMAL(12, 2) NOT NULL,
    tax_amount DECIMAL(12, 2) DEFAULT 0,
    shipping_amount DECIMAL(12, 2) DEFAULT 0,
    discount_amount DECIMAL(12, 2) DEFAULT 0,
    total_amount DECIMAL(12, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'JPY',
    shipping_address JSONB NOT NULL,
    billing_address JSONB,
    notes TEXT,
    metadata JSONB DEFAULT '{}',
    ordered_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    shipped_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE orders IS 'Customer orders - RESTRICT delete to protect order history';
COMMENT ON COLUMN orders.shipping_address IS 'Snapshot of shipping address at order time';

--
-- Table: order_items
--
CREATE TABLE order_items (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    product_name VARCHAR(200) NOT NULL,
    product_sku VARCHAR(50) NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price DECIMAL(10, 2) NOT NULL,
    total_price DECIMAL(12, 2) NOT NULL,
    attributes JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE order_items IS 'Order line items - CASCADE delete with order';

--
-- Table: reviews
--
CREATE TABLE reviews (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    title VARCHAR(200),
    content TEXT,
    is_verified_purchase BOOLEAN DEFAULT false,
    helpful_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(product_id, user_id)
);

COMMENT ON TABLE reviews IS 'Product reviews - CASCADE delete with product or user';

--
-- Table: shopping_cart
--
CREATE TABLE shopping_cart (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    session_id VARCHAR(100),
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity INTEGER NOT NULL DEFAULT 1,
    attributes JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE shopping_cart IS 'Shopping cart items - CASCADE delete';

--
-- Table: coupons
--
CREATE TABLE coupons (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) NOT NULL UNIQUE,
    description TEXT,
    discount_type VARCHAR(20) NOT NULL,
    discount_value DECIMAL(10, 2) NOT NULL,
    minimum_order DECIMAL(10, 2),
    maximum_discount DECIMAL(10, 2),
    usage_limit INTEGER,
    used_count INTEGER DEFAULT 0,
    valid_from TIMESTAMP WITH TIME ZONE,
    valid_until TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    conditions JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE coupons IS 'Discount coupons with JSON conditions';

--
-- Table: order_coupons (Junction table)
--
CREATE TABLE order_coupons (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
    discount_applied DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (order_id, coupon_id)
);

--
-- Table: inventory_logs
--
CREATE TABLE inventory_logs (
    id SERIAL PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    change_type VARCHAR(50) NOT NULL,
    quantity_change INTEGER NOT NULL,
    previous_quantity INTEGER NOT NULL,
    new_quantity INTEGER NOT NULL,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE inventory_logs IS 'Inventory change tracking';

--
-- Table: audit_logs (For compliance/tracking)
--
CREATE TABLE audit_logs (
    id SERIAL PRIMARY KEY,
    table_name VARCHAR(100) NOT NULL,
    record_id INTEGER NOT NULL,
    action VARCHAR(20) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE audit_logs IS 'System audit trail with JSON diff';

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_sku ON products(sku);
CREATE INDEX idx_products_active ON products(is_active) WHERE is_active = true;
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_number ON orders(order_number);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_reviews_product ON reviews(product_id);
CREATE INDEX idx_reviews_user ON reviews(user_id);
CREATE INDEX idx_cart_user ON shopping_cart(user_id);
CREATE INDEX idx_cart_session ON shopping_cart(session_id);
CREATE INDEX idx_audit_table_record ON audit_logs(table_name, record_id);

-- ============================================
-- SAMPLE DATA
-- ============================================

-- Users (demonstrating various data patterns)
INSERT INTO users (email, username, password_hash, full_name, phone, preferences) VALUES
('admin@example.com', 'admin', '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.V5/X4.V5/X4.V5', 'Admin User', '+81-90-1234-5678', '{"theme": "dark", "notifications": {"email": true, "push": true}, "language": "ja"}'),
('tanaka.taro@example.com', 'tanaka_taro', '$2b$12$hash...', '田中 太郎', '+81-90-2345-6789', '{"theme": "light", "notifications": {"email": true, "push": false}, "language": "ja"}'),
('sato.hanako@example.com', 'sato_hanako', '$2b$12$hash...', '佐藤 花子', '+81-80-3456-7890', '{"theme": "auto", "notifications": {"email": false, "push": true}, "language": "ja"}'),
('suzuki.ichiro@example.com', 'suzuki_ichiro', '$2b$12$hash...', '鈴木 一郎', '+81-70-4567-8901', '{"theme": "dark", "language": "ja"}'),
('yamamoto.yuki@example.com', 'yamamoto_yuki', '$2b$12$hash...', '山本 由紀', '+81-90-5678-9012', '{"theme": "light", "language": "en"}'),
('watanabe.ken@example.com', 'watanabe_ken', '$2b$12$hash...', '渡辺 健', '+81-80-6789-0123', '{"theme": "dark", "notifications": {"email": true}, "language": "ja"}'),
('ito.mari@example.com', 'ito_mari', '$2b$12$hash...', '伊藤 真理', '+81-70-7890-1234', '{"language": "ja"}'),
('nakamura.koji@example.com', 'nakamura_koji', '$2b$12$hash...', '中村 浩二', '+81-90-8901-2345', '{"theme": "light", "notifications": {"email": true, "push": true}}'),
('john.smith@example.com', 'john_smith', '$2b$12$hash...', 'John Smith', '+1-555-123-4567', '{"theme": "dark", "language": "en", "currency": "USD"}'),
('emma.wilson@example.com', 'emma_wilson', '$2b$12$hash...', 'Emma Wilson', '+44-20-7123-4567', '{"theme": "light", "language": "en", "currency": "GBP"}');

-- Categories (hierarchical structure)
INSERT INTO categories (name, slug, description, parent_id, display_order, metadata) VALUES
('Electronics', 'electronics', 'Electronic devices and accessories', NULL, 1, '{"icon": "laptop", "featured": true}'),
('Smartphones', 'smartphones', 'Mobile phones and accessories', 1, 1, '{"icon": "smartphone"}'),
('Laptops', 'laptops', 'Notebook computers', 1, 2, '{"icon": "laptop"}'),
('Accessories', 'accessories', 'Electronic accessories', 1, 3, '{"icon": "headphones"}'),
('Fashion', 'fashion', 'Clothing and accessories', NULL, 2, '{"icon": "shirt", "featured": true}'),
('Men''s Wear', 'mens-wear', 'Men''s clothing', 5, 1, '{"icon": "shirt"}'),
('Women''s Wear', 'womens-wear', 'Women''s clothing', 5, 2, '{"icon": "dress"}'),
('Home & Garden', 'home-garden', 'Home and garden products', NULL, 3, '{"icon": "home"}'),
('Furniture', 'furniture', 'Home furniture', 8, 1, '{"icon": "sofa"}'),
('Kitchen', 'kitchen', 'Kitchen appliances and tools', 8, 2, '{"icon": "utensils"}'),
('Books', 'books', 'Books and publications', NULL, 4, '{"icon": "book"}'),
('Sports', 'sports', 'Sports and outdoor equipment', NULL, 5, '{"icon": "dumbbell"}');

-- Products (with various JSON attributes)
INSERT INTO products (sku, name, description, category_id, price, compare_at_price, stock_quantity, dimensions, attributes, tags, is_featured) VALUES
('SP-001', 'iPhone 15 Pro', 'Latest iPhone with titanium design', 2, 159800, 169800, 50, '{"length": 14.6, "width": 7.1, "height": 0.83, "unit": "cm"}', '{"color": "Natural Titanium", "storage": "256GB", "carrier": "SIM Free"}', ARRAY['apple', 'smartphone', 'premium'], true),
('SP-002', 'Galaxy S24 Ultra', 'Samsung flagship smartphone', 2, 189800, NULL, 35, '{"length": 16.2, "width": 7.9, "height": 0.86, "unit": "cm"}', '{"color": "Titanium Gray", "storage": "512GB", "carrier": "SIM Free"}', ARRAY['samsung', 'android', 'premium'], true),
('SP-003', 'Pixel 8 Pro', 'Google AI-powered smartphone', 2, 129800, 139800, 45, '{"length": 16.27, "width": 7.64, "height": 0.88, "unit": "cm"}', '{"color": "Obsidian", "storage": "256GB"}', ARRAY['google', 'android', 'ai'], false),
('LP-001', 'MacBook Pro 14"', 'Apple M3 Pro laptop', 3, 298800, NULL, 25, '{"length": 31.26, "width": 22.12, "height": 1.55, "unit": "cm"}', '{"chip": "M3 Pro", "memory": "18GB", "storage": "512GB SSD", "color": "Space Black"}', ARRAY['apple', 'laptop', 'professional'], true),
('LP-002', 'ThinkPad X1 Carbon', 'Lenovo business ultrabook', 3, 198000, 228000, 30, '{"length": 31.5, "width": 22.2, "height": 1.49, "unit": "cm"}', '{"cpu": "Intel Core i7", "memory": "16GB", "storage": "512GB SSD"}', ARRAY['lenovo', 'business', 'ultrabook'], false),
('LP-003', 'Dell XPS 15', 'Dell premium laptop', 3, 248000, NULL, 20, '{"length": 34.4, "width": 23.0, "height": 1.8, "unit": "cm"}', '{"cpu": "Intel Core i7", "memory": "32GB", "storage": "1TB SSD", "display": "OLED"}', ARRAY['dell', 'creative', 'premium'], true),
('AC-001', 'AirPods Pro 2', 'Apple wireless earbuds', 4, 39800, NULL, 100, '{"case_length": 6.06, "case_width": 5.4, "case_height": 2.17, "unit": "cm"}', '{"color": "White", "features": ["ANC", "Spatial Audio", "Adaptive Audio"]}', ARRAY['apple', 'earbuds', 'wireless'], true),
('AC-002', 'Sony WH-1000XM5', 'Premium noise-canceling headphones', 4, 49800, 54800, 40, '{"folded_length": 25.0, "width": 22.0, "height": 6.0, "unit": "cm"}', '{"color": "Black", "battery_hours": 30, "features": ["ANC", "LDAC", "Multipoint"]}', ARRAY['sony', 'headphones', 'anc'], true),
('AC-003', 'Anker PowerCore 26800', 'High-capacity portable charger', 4, 5980, 6980, 200, '{"length": 18.0, "width": 8.0, "height": 2.2, "unit": "cm"}', '{"capacity_mah": 26800, "ports": 3, "output_w": 45}', ARRAY['anker', 'charger', 'portable'], false),
('FN-001', 'Premium Cotton T-Shirt', 'High-quality cotton t-shirt', 6, 4980, NULL, 150, NULL, '{"sizes": ["S", "M", "L", "XL"], "colors": ["White", "Black", "Navy"]}', ARRAY['cotton', 'basic', 'mens'], false),
('FN-002', 'Wool Blend Sweater', 'Warm wool blend sweater', 7, 12800, 15800, 60, NULL, '{"sizes": ["S", "M", "L"], "colors": ["Beige", "Gray"], "material": "Wool 60%, Acrylic 40%"}', ARRAY['wool', 'winter', 'womens'], false),
('HG-001', 'Ergonomic Office Chair', 'Adjustable ergonomic chair', 9, 49800, 59800, 25, '{"width": 70, "depth": 70, "height_min": 95, "height_max": 110, "unit": "cm"}', '{"color": "Black", "features": ["Lumbar Support", "Headrest", "Armrests"]}', ARRAY['office', 'ergonomic', 'chair'], true),
('HG-002', 'Standing Desk', 'Electric height-adjustable desk', 9, 69800, NULL, 15, '{"width": 140, "depth": 70, "height_min": 65, "height_max": 125, "unit": "cm"}', '{"color": "Walnut", "motor": "dual", "memory_positions": 4}', ARRAY['desk', 'standing', 'electric'], true),
('KT-001', 'Instant Pot Duo 7-in-1', 'Multi-use pressure cooker', 10, 14800, 18800, 45, '{"diameter": 28, "height": 30, "unit": "cm"}', '{"capacity_l": 5.7, "programs": 7, "voltage": "100V"}', ARRAY['cooking', 'pressure', 'instant-pot'], false),
('BK-001', 'Clean Code', 'A Handbook of Agile Software Craftsmanship', 11, 4180, NULL, 30, NULL, '{"author": "Robert C. Martin", "isbn": "978-0132350884", "pages": 464, "language": "English"}', ARRAY['programming', 'software', 'best-practices'], false),
('BK-002', 'Design Patterns', 'Elements of Reusable Object-Oriented Software', 11, 6380, NULL, 20, NULL, '{"authors": ["Erich Gamma", "Richard Helm", "Ralph Johnson", "John Vlissides"], "isbn": "978-0201633610", "pages": 416}', ARRAY['programming', 'patterns', 'oop'], false),
('SP-004', 'Running Shoes Pro', 'Professional running shoes', 12, 15800, 18800, 80, NULL, '{"sizes": [25, 25.5, 26, 26.5, 27, 27.5, 28], "colors": ["Black/Red", "White/Blue"]}', ARRAY['running', 'shoes', 'sports'], false),
('SP-005', 'Yoga Mat Premium', 'Non-slip yoga mat', 12, 4980, NULL, 120, '{"length": 183, "width": 61, "thickness": 0.6, "unit": "cm"}', '{"color": "Purple", "material": "TPE", "features": ["Non-slip", "Eco-friendly"]}', ARRAY['yoga', 'fitness', 'mat'], false);

-- Product Images
INSERT INTO product_images (product_id, url, alt_text, display_order, is_primary) VALUES
(1, 'https://example.com/images/iphone15-1.jpg', 'iPhone 15 Pro - Front', 1, true),
(1, 'https://example.com/images/iphone15-2.jpg', 'iPhone 15 Pro - Back', 2, false),
(2, 'https://example.com/images/galaxy-s24-1.jpg', 'Galaxy S24 Ultra - Front', 1, true),
(3, 'https://example.com/images/pixel8-1.jpg', 'Pixel 8 Pro - Front', 1, true),
(4, 'https://example.com/images/macbook-1.jpg', 'MacBook Pro 14 - Open', 1, true),
(4, 'https://example.com/images/macbook-2.jpg', 'MacBook Pro 14 - Side', 2, false),
(5, 'https://example.com/images/thinkpad-1.jpg', 'ThinkPad X1 Carbon', 1, true),
(6, 'https://example.com/images/xps15-1.jpg', 'Dell XPS 15', 1, true),
(7, 'https://example.com/images/airpods-1.jpg', 'AirPods Pro 2', 1, true),
(8, 'https://example.com/images/wh1000xm5-1.jpg', 'Sony WH-1000XM5', 1, true);

-- User Addresses
INSERT INTO user_addresses (user_id, label, recipient_name, street_address, city, state, postal_code, country, phone, is_default) VALUES
(1, 'Office', 'Admin User', '1-2-3 Marunouchi', 'Chiyoda-ku, Tokyo', 'Tokyo', '100-0005', 'Japan', '+81-90-1234-5678', true),
(2, 'Home', '田中 太郎', '4-5-6 Shibuya', 'Shibuya-ku, Tokyo', 'Tokyo', '150-0002', 'Japan', '+81-90-2345-6789', true),
(2, 'Work', '田中 太郎', '7-8-9 Shinjuku', 'Shinjuku-ku, Tokyo', 'Tokyo', '160-0022', 'Japan', '+81-90-2345-6789', false),
(3, 'Home', '佐藤 花子', '10-11-12 Minato', 'Minato-ku, Tokyo', 'Tokyo', '105-0001', 'Japan', '+81-80-3456-7890', true),
(4, 'Home', '鈴木 一郎', '1-1-1 Umeda', 'Osaka', 'Osaka', '530-0001', 'Japan', '+81-70-4567-8901', true),
(5, 'Home', '山本 由紀', '2-2-2 Sakae', 'Nagoya', 'Aichi', '460-0008', 'Japan', '+81-90-5678-9012', true),
(9, 'Home', 'John Smith', '123 Main Street', 'San Francisco', 'California', '94102', 'United States', '+1-555-123-4567', true),
(10, 'Home', 'Emma Wilson', '45 Oxford Street', 'London', '', 'W1D 1BS', 'United Kingdom', '+44-20-7123-4567', true);

-- Orders (various statuses and dates)
INSERT INTO orders (order_number, user_id, status, subtotal, tax_amount, shipping_amount, discount_amount, total_amount, shipping_address, ordered_at, shipped_at, delivered_at) VALUES
('ORD-2026-0001', 2, 'delivered', 159800, 15980, 0, 0, 175780, '{"name": "田中 太郎", "street": "4-5-6 Shibuya", "city": "Shibuya-ku, Tokyo", "postal_code": "150-0002", "country": "Japan"}', '2026-01-05 10:30:00+09', '2026-01-06 09:00:00+09', '2026-01-07 14:00:00+09'),
('ORD-2026-0002', 3, 'delivered', 49800, 4980, 500, 5000, 50280, '{"name": "佐藤 花子", "street": "10-11-12 Minato", "city": "Minato-ku, Tokyo", "postal_code": "105-0001", "country": "Japan"}', '2026-01-06 14:20:00+09', '2026-01-07 10:00:00+09', '2026-01-08 11:00:00+09'),
('ORD-2026-0003', 4, 'shipped', 298800, 29880, 0, 0, 328680, '{"name": "鈴木 一郎", "street": "1-1-1 Umeda", "city": "Osaka", "postal_code": "530-0001", "country": "Japan"}', '2026-01-10 16:45:00+09', '2026-01-11 08:00:00+09', NULL),
('ORD-2026-0004', 2, 'processing', 69800, 6980, 1500, 0, 78280, '{"name": "田中 太郎", "street": "7-8-9 Shinjuku", "city": "Shinjuku-ku, Tokyo", "postal_code": "160-0022", "country": "Japan"}', '2026-01-15 09:00:00+09', NULL, NULL),
('ORD-2026-0005', 5, 'pending', 189800, 18980, 0, 10000, 198780, '{"name": "山本 由紀", "street": "2-2-2 Sakae", "city": "Nagoya", "postal_code": "460-0008", "country": "Japan"}', '2026-01-18 11:30:00+09', NULL, NULL),
('ORD-2026-0006', 9, 'delivered', 159800, 0, 2500, 0, 162300, '{"name": "John Smith", "street": "123 Main Street", "city": "San Francisco", "state": "CA", "postal_code": "94102", "country": "United States"}', '2026-01-08 22:00:00+09', '2026-01-09 12:00:00+09', '2026-01-15 10:00:00+09'),
('ORD-2026-0007', 10, 'shipped', 39800, 0, 3000, 0, 42800, '{"name": "Emma Wilson", "street": "45 Oxford Street", "city": "London", "postal_code": "W1D 1BS", "country": "United Kingdom"}', '2026-01-12 18:00:00+09', '2026-01-13 11:00:00+09', NULL),
('ORD-2026-0008', 6, 'delivered', 248000, 24800, 0, 24800, 248000, '{"name": "渡辺 健", "street": "3-3-3 Hakata", "city": "Fukuoka", "postal_code": "812-0011", "country": "Japan"}', '2026-01-03 13:00:00+09', '2026-01-04 09:00:00+09', '2026-01-05 16:00:00+09'),
('ORD-2026-0009', 7, 'cancelled', 15800, 1580, 500, 0, 17880, '{"name": "伊藤 真理", "street": "5-5-5 Kanazawa", "city": "Kanazawa", "postal_code": "920-0962", "country": "Japan"}', '2026-01-14 20:00:00+09', NULL, NULL),
('ORD-2026-0010', 8, 'processing', 119600, 11960, 0, 5980, 125580, '{"name": "中村 浩二", "street": "6-6-6 Sapporo", "city": "Sapporo", "postal_code": "060-0001", "country": "Japan"}', '2026-01-19 15:30:00+09', NULL, NULL);

-- Order Items
INSERT INTO order_items (order_id, product_id, product_name, product_sku, quantity, unit_price, total_price, attributes) VALUES
(1, 1, 'iPhone 15 Pro', 'SP-001', 1, 159800, 159800, '{"color": "Natural Titanium", "storage": "256GB"}'),
(2, 8, 'Sony WH-1000XM5', 'AC-002', 1, 49800, 49800, '{"color": "Black"}'),
(3, 4, 'MacBook Pro 14"', 'LP-001', 1, 298800, 298800, '{"chip": "M3 Pro", "color": "Space Black"}'),
(4, 13, 'Standing Desk', 'HG-002', 1, 69800, 69800, '{"color": "Walnut"}'),
(5, 2, 'Galaxy S24 Ultra', 'SP-002', 1, 189800, 189800, '{"color": "Titanium Gray", "storage": "512GB"}'),
(6, 1, 'iPhone 15 Pro', 'SP-001', 1, 159800, 159800, '{"color": "Natural Titanium", "storage": "256GB"}'),
(7, 7, 'AirPods Pro 2', 'AC-001', 1, 39800, 39800, '{"color": "White"}'),
(8, 6, 'Dell XPS 15', 'LP-003', 1, 248000, 248000, '{"cpu": "Intel Core i7", "memory": "32GB"}'),
(9, 17, 'Running Shoes Pro', 'SP-004', 1, 15800, 15800, '{"size": 26.5, "color": "Black/Red"}'),
(10, 12, 'Ergonomic Office Chair', 'HG-001', 1, 49800, 49800, '{"color": "Black"}'),
(10, 13, 'Standing Desk', 'HG-002', 1, 69800, 69800, '{"color": "Walnut"}');

-- Reviews
INSERT INTO reviews (product_id, user_id, rating, title, content, is_verified_purchase, helpful_count) VALUES
(1, 2, 5, 'Best iPhone ever!', 'The titanium design is amazing. Camera quality is outstanding. Battery life improved significantly.', true, 45),
(1, 5, 4, 'Great but expensive', 'Excellent phone but the price is quite high. ProMotion display is smooth.', true, 23),
(4, 4, 5, 'Perfect for development', 'M3 Pro handles everything I throw at it. Build times are incredibly fast.', true, 67),
(8, 3, 5, 'Best noise canceling', 'The ANC is incredible. Comfortable for long listening sessions.', true, 89),
(6, 6, 4, 'Beautiful display', 'OLED display is stunning. Gets a bit warm under heavy load.', true, 34),
(7, 10, 5, 'Love these!', 'Great sound quality and the case is compact. Adaptive audio is a game changer.', true, 56),
(12, 8, 4, 'Very comfortable', 'Great for long work sessions. Assembly was straightforward.', true, 28),
(13, 2, 5, 'Life changing desk', 'Standing desk has improved my posture significantly. Motor is quiet.', true, 41),
(2, 9, 5, 'Amazing camera', 'The zoom capabilities are incredible. S Pen is useful for note-taking.', true, 38),
(3, 7, 4, 'AI features are cool', 'Magic Eraser and Best Take are useful. Stock Android is clean.', false, 19);

-- Shopping Cart (active carts)
INSERT INTO shopping_cart (user_id, session_id, product_id, quantity, attributes) VALUES
(2, NULL, 7, 1, '{"color": "White"}'),
(2, NULL, 9, 2, '{}'),
(3, NULL, 15, 1, '{}'),
(5, NULL, 4, 1, '{"chip": "M3 Pro", "color": "Space Black"}'),
(NULL, 'sess_abc123', 1, 1, '{"color": "Blue Titanium"}'),
(NULL, 'sess_def456', 8, 1, '{"color": "Silver"}');

-- Coupons
INSERT INTO coupons (code, description, discount_type, discount_value, minimum_order, maximum_discount, usage_limit, used_count, valid_from, valid_until, conditions) VALUES
('WELCOME10', 'Welcome discount for new users', 'percentage', 10, 5000, 10000, 1000, 156, '2026-01-01 00:00:00+09', '2026-12-31 23:59:59+09', '{"new_users_only": true, "categories": []}'),
('NEWYEAR2026', 'New Year Special 2026', 'percentage', 15, 10000, 20000, 500, 234, '2026-01-01 00:00:00+09', '2026-01-31 23:59:59+09', '{"categories": ["electronics"]}'),
('FREESHIP', 'Free shipping coupon', 'fixed', 1500, 8000, NULL, NULL, 89, '2026-01-01 00:00:00+09', NULL, '{"shipping_only": true}'),
('TECH20', '20% off electronics', 'percentage', 20, 30000, 50000, 100, 45, '2026-01-15 00:00:00+09', '2026-02-28 23:59:59+09', '{"categories": ["electronics", "laptops", "smartphones"]}'),
('VIP500', 'VIP member 500 yen off', 'fixed', 500, 3000, NULL, NULL, 312, NULL, NULL, '{"vip_only": true}');

-- Order Coupons
INSERT INTO order_coupons (order_id, coupon_id, discount_applied) VALUES
(2, 1, 5000),
(5, 2, 10000),
(8, 4, 24800),
(10, 3, 0);

-- Inventory Logs
INSERT INTO inventory_logs (product_id, change_type, quantity_change, previous_quantity, new_quantity, reference_type, reference_id, notes, created_by) VALUES
(1, 'received', 100, 0, 100, 'purchase_order', 1001, 'Initial stock from supplier', 1),
(1, 'sold', -1, 100, 99, 'order', 1, 'Order ORD-2026-0001', NULL),
(1, 'sold', -1, 99, 98, 'order', 6, 'Order ORD-2026-0006', NULL),
(1, 'adjustment', -48, 98, 50, 'inventory_count', 2001, 'Inventory count adjustment', 1),
(4, 'received', 50, 0, 50, 'purchase_order', 1002, 'Initial stock', 1),
(4, 'sold', -1, 50, 49, 'order', 3, 'Order ORD-2026-0003', NULL),
(4, 'adjustment', -24, 49, 25, 'inventory_count', 2002, 'Damaged items removed', 1),
(8, 'received', 60, 0, 60, 'purchase_order', 1003, 'Initial stock', 1),
(8, 'sold', -1, 60, 59, 'order', 2, 'Order ORD-2026-0002', NULL),
(8, 'return', 1, 39, 40, 'return', 3001, 'Customer return - defective', NULL);

-- Audit Logs (sample entries)
INSERT INTO audit_logs (table_name, record_id, action, old_values, new_values, user_id, ip_address, user_agent) VALUES
('users', 2, 'UPDATE', '{"email_verified": false}', '{"email_verified": true}', 1, '192.168.1.100', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'),
('products', 1, 'UPDATE', '{"price": 169800}', '{"price": 159800}', 1, '192.168.1.100', 'Mozilla/5.0'),
('orders', 1, 'UPDATE', '{"status": "processing"}', '{"status": "shipped"}', 1, '192.168.1.100', 'Mozilla/5.0'),
('orders', 1, 'UPDATE', '{"status": "shipped"}', '{"status": "delivered"}', NULL, '10.0.0.50', 'DeliveryService/1.0'),
('products', 5, 'UPDATE', '{"stock_quantity": 35}', '{"stock_quantity": 30}', NULL, NULL, 'InventorySystem/2.0'),
('coupons', 1, 'UPDATE', '{"used_count": 155}', '{"used_count": 156}', NULL, NULL, 'OrderService/1.0');

-- ============================================
-- VIEWS (optional)
-- ============================================

CREATE VIEW v_product_summary AS
SELECT 
    p.id,
    p.sku,
    p.name,
    c.name as category_name,
    p.price,
    p.stock_quantity,
    COALESCE(AVG(r.rating), 0) as avg_rating,
    COUNT(DISTINCT r.id) as review_count
FROM products p
LEFT JOIN categories c ON p.category_id = c.id
LEFT JOIN reviews r ON p.id = r.product_id
GROUP BY p.id, p.sku, p.name, c.name, p.price, p.stock_quantity;

CREATE VIEW v_user_order_stats AS
SELECT 
    u.id as user_id,
    u.username,
    u.email,
    COUNT(o.id) as order_count,
    COALESCE(SUM(o.total_amount), 0) as total_spent,
    MAX(o.ordered_at) as last_order_date
FROM users u
LEFT JOIN orders o ON u.id = o.user_id AND o.status != 'cancelled'
GROUP BY u.id, u.username, u.email;

--
-- End of PgDumpLens Demo Database
--
