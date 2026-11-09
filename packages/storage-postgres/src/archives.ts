import type { PoolClient } from 'pg'
import {
  archiveBlockBytes,
  archiveDigest,
  archiveIdentity,
  archiveManifest,
  archiveSha256,
  archiveStartDigest,
  scanArchiveBlock,
  type ArchiveEntry,
  type ArchiveManifest,
} from '../../protocol/src/archives.js'
import { MeshError } from '../../protocol/src/index.js'
import { HandoffPostgresStore } from './handoff-store.js'

interface UploadRow {
  id: string
  publisher: string
  manifest: ArchiveManifest
  next_block: string
  next_record: string
  uploaded_bytes: string
  remaining: string
  partial_header: Buffer
  chain: string
  committed_at: Date | null
  expired: boolean
}

const missing = () => new MeshError('NOT_FOUND', 'No archive is available', 404)
const conflict = (message: string) =>
  new MeshError('ARCHIVE_CONFLICT', message, 409)
const damage = () =>
  new MeshError('CORRUPTION', 'Archive data failed verification', 422)

export class ArchivePostgresStore extends HandoffPostgresStore {
  private async archiveWrite(db: PoolClient, ns: string) {
    await db.query(
      'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))',
      ['maintenance:' + ns],
    )
    const result = await db.query(
      'SELECT enabled FROM cm_maintenance WHERE namespace=$1',
      [ns],
    )
    if (result.rows[0]?.enabled)
      throw new MeshError(
        'MAINTENANCE',
        'Archive writes are paused for maintenance',
        503,
      )
  }

  private uploadStatus(row: UploadRow) {
    return {
      id: row.id,
      next: Number(row.next_block),
      committed: row.committed_at !== null,
    }
  }

  private async findUpload(
    db: PoolClient,
    ns: string,
    id: string,
    actor: string,
    lock = false,
  ) {
    const {
      rows: [row],
    } = await db.query<UploadRow>(
      'SELECT *, expires_at <= clock_timestamp() AS expired FROM cm_archives WHERE namespace=$1 AND id=$2' +
        (lock ? ' FOR UPDATE' : ''),
      [ns, id],
    )
    if (!row || (!row.committed_at && row.publisher !== actor)) throw missing()
    if (!row.committed_at && row.expired)
      throw new MeshError(
        'ARCHIVE_UPLOAD_EXPIRED',
        'This upload expired; start it again from the saved copy',
        410,
      )
    return row
  }

  async pruneArchiveUploads(ns: string) {
    await this.pool.query(
      `DELETE FROM cm_archives WHERE namespace=$1 AND id IN (
         SELECT id FROM cm_archives WHERE namespace=$1 AND committed_at IS NULL
           AND expires_at <= clock_timestamp()
         ORDER BY expires_at LIMIT 8 FOR UPDATE SKIP LOCKED
       ) AND committed_at IS NULL AND expires_at <= clock_timestamp()`,
      [ns],
    )
  }

  async beginArchive(
    ns: string,
    actor: string,
    input: ArchiveManifest,
    quotaBytes: number,
  ) {
    const manifest = archiveManifest.parse(input)
    const id = archiveIdentity(manifest)
    return this.tx(async (db) => {
      await this.archiveWrite(db, ns)
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        'archive-quota:' + ns,
      ])
      const {
        rows: [existing],
      } = await db.query<UploadRow>(
        'SELECT *, expires_at <= clock_timestamp() AS expired FROM cm_archives WHERE namespace=$1 AND id=$2 FOR UPDATE',
        [ns, id],
      )
      if (existing?.committed_at) return this.uploadStatus(existing)
      if (existing && !existing.expired) {
        if (existing.publisher !== actor)
          throw conflict('Another device is already uploading this archive')
        return this.uploadStatus(existing)
      }
      if (existing)
        await db.query('DELETE FROM cm_archives WHERE namespace=$1 AND id=$2', [
          ns,
          id,
        ])
      if (manifest.header.parent) {
        const parent = await db.query(
          'SELECT 1 FROM cm_archives WHERE namespace=$1 AND id=$2 AND committed_at IS NOT NULL',
          [ns, manifest.header.parent],
        )
        if (!parent.rowCount) throw missing()
      }
      const {
        rows: [usage],
      } = await db.query<{ bytes: string }>(
        'SELECT COALESCE(sum(reserved_bytes),0)::text AS bytes FROM cm_archives WHERE namespace=$1 AND (committed_at IS NOT NULL OR expires_at > clock_timestamp())',
        [ns],
      )
      if (BigInt(usage!.bytes) + BigInt(manifest.bytes) > BigInt(quotaBytes))
        throw new MeshError(
          'ARCHIVE_QUOTA',
          'This namespace has insufficient archive storage',
          507,
        )
      await db.query(
        'INSERT INTO cm_archives(namespace,id,publisher,manifest,reserved_bytes,parent_id,chain) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          ns,
          id,
          actor,
          JSON.stringify(manifest),
          manifest.bytes,
          manifest.header.parent ?? null,
          archiveStartDigest,
        ],
      )
      return { id, next: 0, committed: false }
    })
  }

  async archiveUpload(ns: string, actor: string, id: string) {
    const db = await this.pool.connect()
    try {
      return this.uploadStatus(await this.findUpload(db, ns, id, actor))
    } finally {
      db.release()
    }
  }

  async putArchiveBlock(
    ns: string,
    actor: string,
    id: string,
    seq: number,
    input: { data: string; sha256: string },
  ) {
    const data = Buffer.from(input.data, 'base64')
    if (
      data.toString('base64') !== input.data ||
      archiveSha256(data) !== input.sha256
    )
      throw new MeshError(
        'ARCHIVE_BLOCK_CHECKSUM',
        'Archive block checksum does not match',
        422,
      )
    return this.tx(async (db) => {
      await this.archiveWrite(db, ns)
      const row = await this.findUpload(db, ns, id, actor, true)
      const next = Number(row.next_block)
      if (seq < next) {
        const {
          rows: [stored],
        } = await db.query(
          'SELECT digest FROM cm_archive_blocks WHERE namespace=$1 AND archive_id=$2 AND seq=$3',
          [ns, id, seq],
        )
        if (stored?.digest === input.sha256) return this.uploadStatus(row)
        throw conflict('This block number already contains different data')
      }
      if (row.committed_at || seq !== next || seq >= row.manifest.blocks)
        throw conflict('This block is out of order')
      const uploaded = Number(row.uploaded_bytes)
      if (
        data.length !==
        Math.min(archiveBlockBytes, row.manifest.bytes - uploaded)
      )
        throw conflict('This block does not match the declared size')
      const scan = scanArchiveBlock(
        data,
        uploaded,
        {
          partial: row.partial_header,
          remaining: Number(row.remaining),
          records: Number(row.next_record),
        },
        row.manifest.header.scope,
      )
      const bytes = uploaded + data.length
      if (
        scan.records > row.manifest.records ||
        scan.remaining > row.manifest.bytes - bytes
      )
        throw conflict('The record index exceeds the declared archive')
      await db.query(
        'INSERT INTO cm_archive_blocks(namespace,archive_id,seq,digest,data) VALUES($1,$2,$3,$4,$5)',
        [ns, id, seq, input.sha256, data],
      )
      if (scan.entries.length)
        await db.query(
          `INSERT INTO cm_archive_entries(namespace,archive_id,seq,byte_start,meta,terms)
           SELECT $1,$2,(item->'entry'->>'seq')::bigint,(item->>'position')::bigint,
             item->'entry',ARRAY(
               SELECT jsonb_array_elements_text(item->'entry'->'terms')
               UNION
               SELECT jsonb_array_elements_text(anchor->'terms')
               FROM jsonb_array_elements(item->'entry'->'anchors') anchor
             )
           FROM jsonb_array_elements($3::jsonb) item`,
          [ns, id, JSON.stringify(scan.entries)],
        )
      await db.query(
        `UPDATE cm_archives SET next_block=$3,next_record=$4,uploaded_bytes=$5,
           remaining=$6,partial_header=$7,chain=$8,expires_at=clock_timestamp()+interval '24 hours'
         WHERE namespace=$1 AND id=$2`,
        [
          ns,
          id,
          next + 1,
          scan.records,
          bytes,
          scan.remaining,
          scan.partial,
          archiveDigest(row.chain, input.sha256),
        ],
      )
      return { id, next: next + 1, committed: false }
    })
  }

  async commitArchive(ns: string, actor: string, id: string) {
    return this.tx(async (db) => {
      await this.archiveWrite(db, ns)
      const row = await this.findUpload(db, ns, id, actor, true)
      const { blocks, bytes, records, digest } = row.manifest
      if (row.committed_at) return this.uploadStatus(row)
      if (
        Number(row.next_block) !== blocks ||
        Number(row.uploaded_bytes) !== bytes ||
        Number(row.next_record) !== records ||
        Number(row.remaining) !== 0 ||
        row.partial_header.length ||
        row.chain !== digest
      )
        throw conflict('The archive is incomplete or its digest does not match')
      await db.query(
        'UPDATE cm_archives SET committed_at=clock_timestamp() WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
      return { id, next: blocks, committed: true }
    })
  }

  async archiveInfo(ns: string, id: string) {
    const {
      rows: [row],
    } = await this.pool.query<{
      id: string
      manifest: ArchiveManifest
      committed_at: Date
    }>(
      'SELECT id,manifest,committed_at FROM cm_archives WHERE namespace=$1 AND id=$2 AND committed_at IS NOT NULL',
      [ns, id],
    )
    if (!row) throw missing()
    return {
      id: row.id,
      manifest: row.manifest,
      createdAt: row.committed_at.getTime(),
    }
  }

  async archiveCatalog(ns: string, after?: string) {
    const { rows } = await this.pool.query<{
      id: string
      manifest: ArchiveManifest
      committed_at: Date
    }>(
      `SELECT id,manifest,committed_at FROM cm_archives WHERE namespace=$1 AND committed_at IS NOT NULL
        AND ($2::text IS NULL OR (committed_at,id) < (
          SELECT committed_at,id FROM cm_archives WHERE namespace=$1 AND id=$2 AND committed_at IS NOT NULL
        )) ORDER BY committed_at DESC,id DESC LIMIT 65`,
      [ns, after ?? null],
    )
    return {
      archives: rows.slice(0, 64).map((row) => ({
        id: row.id,
        manifest: row.manifest,
        createdAt: row.committed_at.getTime(),
      })),
      next: rows.length > 64 ? rows[63]!.id : null,
    }
  }

  async archiveIndex(
    ns: string,
    id: string,
    q: {
      after?: number
      limit: number
      order: 'asc' | 'desc'
      terms: string[]
      textOnly?: boolean
      role?: ArchiveEntry['role']
    },
  ) {
    await this.archiveInfo(ns, id)
    const asc = q.order === 'asc'
    const { rows } = await this.pool.query<{ meta: ArchiveEntry }>(
      `SELECT meta FROM cm_archive_entries WHERE namespace=$1 AND archive_id=$2
         AND ($3::bigint IS NULL OR seq ${asc ? '>' : '<'} $3)
         AND (cardinality($4::text[])=0 OR terms && $4)
         AND (NOT $5 OR meta->>'role' <> 'reference')
         AND ($7::text IS NULL OR meta->>'role'=$7)
       ORDER BY seq ${asc ? 'ASC' : 'DESC'} LIMIT $6`,
      [
        ns,
        id,
        q.after ?? null,
        q.terms,
        q.textOnly ?? false,
        q.limit + 1,
        q.role ?? null,
      ],
    )
    const sought = new Set(q.terms)
    const hits = (entry: ArchiveEntry['anchors'][number]) =>
      entry.terms.filter((term) => sought.has(term)).length
    const records = rows.slice(0, q.limit).map(({ meta }) =>
      sought.size
        ? {
            ...meta,
            anchors: meta.anchors
              .slice()
              .sort((a, b) => hits(a) - hits(b) || a.offset - b.offset),
          }
        : meta,
    )
    return { records, next: rows.length > q.limit ? records.at(-1)!.seq : null }
  }

  async archiveRecordContent(
    ns: string,
    id: string,
    seq: number,
    offset: number,
    length: number,
  ) {
    await this.archiveInfo(ns, id)
    const {
      rows: [row],
    } = await this.pool.query<{ byte_start: string; meta: ArchiveEntry }>(
      'SELECT byte_start,meta FROM cm_archive_entries WHERE namespace=$1 AND archive_id=$2 AND seq=$3',
      [ns, id, seq],
    )
    if (!row) throw missing()
    if (offset > row.meta.bytes)
      throw new MeshError(
        'ARCHIVE_RANGE',
        'Offset is outside the archive record',
        416,
      )
    const size = Math.min(length, row.meta.bytes - offset)
    if (!size) return { data: '', next: null }
    const start = Number(row.byte_start) + offset
    const first = Math.floor(start / archiveBlockBytes)
    const last = Math.floor((start + size - 1) / archiveBlockBytes)
    const { rows: blocks } = await this.pool.query<{
      seq: string
      data: Buffer
      digest: string
    }>(
      'SELECT seq,data,digest FROM cm_archive_blocks WHERE namespace=$1 AND archive_id=$2 AND seq BETWEEN $3 AND $4 ORDER BY seq',
      [ns, id, first, last],
    )
    if (
      blocks.length !== last - first + 1 ||
      blocks.some(
        (block, i) =>
          Number(block.seq) !== first + i ||
          archiveSha256(block.data) !== block.digest,
      )
    )
      throw damage()
    const index = start % archiveBlockBytes
    const data = Buffer.concat(blocks.map((block) => block.data)).subarray(
      index,
      index + size,
    )
    if (data.length !== size) throw damage()
    return {
      data: data.toString('base64'),
      next: offset + size < row.meta.bytes ? offset + size : null,
    }
  }
}
