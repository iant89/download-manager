/**
 * Incremental SHA-256 (plan P2-15).
 *
 * WebCrypto's `digest()` only accepts a whole buffer, which is fine for small
 * files but would pull a multi-gigabyte download into memory. This streaming
 * implementation lets sinks hash data as it flows (StreamSink) or read a file
 * back in slices (FsaSink).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  private block = new Uint8Array(64)
  private blockLength = 0
  private bytes = 0
  private w = new Uint32Array(64)
  private finished = false

  update(data: Uint8Array): this {
    if (this.finished) throw new Error('Sha256: update() after digest()')
    let i = 0
    this.bytes += data.byteLength
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.byteLength)
      this.block.set(data.subarray(0, take), this.blockLength)
      this.blockLength += take
      i = take
      if (this.blockLength === 64) {
        this.compress(this.block, 0)
        this.blockLength = 0
      }
    }
    for (; i + 64 <= data.byteLength; i += 64) this.compress(data, i)
    if (i < data.byteLength) {
      this.block.set(data.subarray(i), 0)
      this.blockLength = data.byteLength - i
    }
    return this
  }

  digestHex(): string {
    if (this.finished) throw new Error('Sha256: digest() called twice')
    const bitLength = this.bytes * 8
    const padLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength
    const pad = new Uint8Array(padLength + 8)
    pad[0] = 0x80
    const view = new DataView(pad.buffer)
    // 64-bit big-endian length (safe up to 2^53 bits).
    view.setUint32(padLength, Math.floor(bitLength / 0x1_0000_0000))
    view.setUint32(padLength + 4, bitLength >>> 0)
    this.updatePadding(pad)
    this.finished = true
    let hex = ''
    for (const word of this.h) hex += word.toString(16).padStart(8, '0')
    return hex
  }

  private updatePadding(pad: Uint8Array): void {
    let i = 0
    if (this.blockLength > 0) {
      const take = 64 - this.blockLength
      this.block.set(pad.subarray(0, take), this.blockLength)
      this.compress(this.block, 0)
      this.blockLength = 0
      i = take
    }
    for (; i < pad.byteLength; i += 64) this.compress(pad, i)
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.w
    for (let t = 0; t < 16; t += 1) {
      const j = offset + t * 4
      w[t] = (data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!
    }
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15]!
      const b = w[t - 2]!
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[]
    for (let t = 0; t < 64; t += 1) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7))
      const ch = (e! & f!) ^ (~e! & g!)
      const t1 = (h! + S1 + ch + K[t]! + w[t]!) | 0
      const S0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10))
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d! + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    this.h[0] = (this.h[0]! + a!) | 0
    this.h[1] = (this.h[1]! + b!) | 0
    this.h[2] = (this.h[2]! + c!) | 0
    this.h[3] = (this.h[3]! + d!) | 0
    this.h[4] = (this.h[4]! + e!) | 0
    this.h[5] = (this.h[5]! + f!) | 0
    this.h[6] = (this.h[6]! + g!) | 0
    this.h[7] = (this.h[7]! + h!) | 0
  }
}

/** Normalizes user input: lowercase hex, no whitespace or "sha256:" prefix. */
export function normalizeChecksum(value: string): string {
  return value.trim().replace(/^sha-?256[:=]\s*/i, '').replace(/\s+/g, '').toLowerCase()
}

export function isValidSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(normalizeChecksum(value))
}

/** Hashes a Blob/File in slices so memory stays bounded. */
export async function sha256OfBlob(blob: Blob, sliceBytes = 8 * 1024 * 1024): Promise<string> {
  const hasher = new Sha256()
  for (let offset = 0; offset < blob.size; offset += sliceBytes) {
    const buffer = await blob.slice(offset, offset + sliceBytes).arrayBuffer()
    hasher.update(new Uint8Array(buffer))
  }
  return hasher.digestHex()
}
