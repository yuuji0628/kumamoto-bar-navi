PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_kana TEXT,
  area TEXT NOT NULL,
  address TEXT,
  hours TEXT,
  holiday TEXT,
  instagram TEXT,
  genre TEXT,
  features TEXT,
  description TEXT,
  budget_min INTEGER,
  budget_max INTEGER,
  seats INTEGER,
  phone TEXT,
  is_recruiting INTEGER NOT NULL DEFAULT 0,
  is_published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shops_area ON shops(area);
CREATE INDEX IF NOT EXISTS idx_shops_genre ON shops(genre);
CREATE INDEX IF NOT EXISTS idx_shops_published ON shops(is_published);

CREATE TRIGGER IF NOT EXISTS trg_shops_updated
AFTER UPDATE ON shops
FOR EACH ROW
BEGIN
  UPDATE shops
  SET updated_at = CURRENT_TIMESTAMP
  WHERE id = OLD.id;
END;
