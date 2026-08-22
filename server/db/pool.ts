// server/db/pool.ts
import { Pool } from 'pg';
import { config } from '@/server/config';

// Next.js dev 的 HMR 會重新執行模組。若在模組層直接 new Pool()，
// 每次熱更新都會多留下一個連線池，連線數會一路累積。
// 掛在 globalThis 上可確保整個 process 只有一個 Pool。
const globalForPool = globalThis as typeof globalThis & {
  __taiwanMapPool?: Pool;
};

function createPool(): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
      rejectUnauthorized: false, // Supabase 雲端連線必須開啟 SSL
    },
  });

  // 少了這個 listener，閒置連線發生錯誤時會以未處理的 'error' 事件讓 process 崩潰
  pool.on('error', (error) => {
    console.error('[db] 閒置連線發生錯誤:', error);
  });

  return pool;
}

/**
 * 整個 Next.js backend 唯一的 PostgreSQL 連線池。
 *
 * 單筆查詢請直接用 `getPool().query(sql, params)`，
 * 它會自動借出並歸還連線；需要多筆查詢共用交易時請用 `withTransaction`。
 */
export function getPool(): Pool {
  if (!globalForPool.__taiwanMapPool) {
    globalForPool.__taiwanMapPool = createPool();
  }
  return globalForPool.__taiwanMapPool;
}
