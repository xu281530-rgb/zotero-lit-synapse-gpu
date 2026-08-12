/**
 * 安全工具函数：会话 ID / 访问令牌的生成与比较。
 */

/**
 * 生成密码学安全的随机标识符（用于 MCP 会话 ID、远程访问令牌）。
 */
export function generateSecureIdentifier(prefix = ""): string {
  try {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return prefix + Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  } catch {
    try {
      const uuid = Services.uuid.generateUUID().toString().replace(/[{}-]/g, "");
      return prefix + uuid + uuid;
    } catch {
      throw new Error("Secure random identifier generation is unavailable");
    }
  }
}

/**
 * 常量时间字符串比较，避免令牌校验被计时攻击推断出内容。
 */
export function constantTimeStringEqual(left: string, right: string): boolean {
  const a = String(left || "");
  const b = String(right || "");
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}
