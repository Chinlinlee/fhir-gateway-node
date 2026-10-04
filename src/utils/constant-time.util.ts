import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 定長比較兩個字串：先各自雜湊到固定長度再 `timingSafeEqual`，讓比較的時間不洩漏
 * 共同前綴長度，也不洩漏哪一段開始不同。
 *
 * 兩邊長度不同時也成立（雜湊長度固定），但那種情況應該由呼叫端當作不相符處理。
 */
export function constantTimeEquals(presented: string, expected: string): boolean {
    const presentedDigest = createHash("sha256").update(presented).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(presentedDigest, expectedDigest);
}
