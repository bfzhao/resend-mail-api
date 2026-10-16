-- 用量统计缓存（前端显示 D1 / R2 占用百分比，提前知道何时该升级）。
-- 值是**估算**：D1 = 各表文本/二进制列的 UTF-8 字节和；R2 = 列举对象求和。见 src/repo.ts 的 getStorageUsage。
-- 直接实时算很贵（D1 全表扫描 / R2 列举按 Class A 计费），故按 TTL 缓存在这里。
CREATE TABLE IF NOT EXISTS app_stats (
    key        TEXT PRIMARY KEY,                    -- 如 'd1_bytes' / 'r2_bytes' / 'r2_objects'
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
