// server/db/transaction.ts
import type { PoolClient } from 'pg';
import { getPool } from '@/server/db/pool';

/**
 * 在單一交易中執行多筆查詢。
 * BEGIN / COMMIT / ROLLBACK 保證成對，連線保證歸還。
 *
 * 注意：callback 內只應該做資料庫操作。
 * Gemini、TDX 等外部 API 請在 withTransaction 之外呼叫，
 * 避免在等待外部回應的期間佔住連線池。
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();

  // BEGIN 失敗時不會進入下面的 try，也就不會對沒有交易的連線下 ROLLBACK
  let inTransaction = false;
  // ROLLBACK 失敗代表連線可能還停在交易中，不能放回池子給下一個人用
  let discardConnection = false;

  try {
    await client.query('BEGIN');
    inTransaction = true;

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (inTransaction) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // ROLLBACK 失敗不能蓋掉原始錯誤，只記錄下來
        console.error('[db] ROLLBACK 失敗:', rollbackError);
        discardConnection = true;
      }
    }
    throw error;
  } finally {
    client.release(discardConnection);
  }
}
