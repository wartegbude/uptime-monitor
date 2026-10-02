import 'server-only'
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from './env'

const key = () => createHash('sha256').update(env.encryptionKey).digest()

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')
}

export function decrypt(blob: string | null | undefined): string | null {
  if (!blob) return null
  try {
    const b = Buffer.from(blob, 'base64')
    const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return null
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const ALPHA = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function randomToken(len = 32): string {
  const bytes = randomBytes(len)
  let s = ''
  for (const b of bytes) s += ALPHA[b % ALPHA.length]
  return s
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Shows only the end of a secret, e.g. "••••••Qz4f". */
export const mask = (s: string | null) => (s ? '••••••••' + s.slice(-4) : null)
