import postgres from 'postgres'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

export function createDb(url: string, maxConnections: number) {
  return postgres(url, { max: maxConnections })
}

export async function runMigrations(sql: postgres.Sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `

  const applied = await sql`SELECT name FROM _migrations`
  const appliedSet = new Set(applied.map((r) => r.name))

  const migrationsDir = join(process.cwd(), 'migrations')
  let files: string[]
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
  } catch {
    console.log('No migrations directory found, skipping')
    return
  }

  for (const file of files) {
    if (!appliedSet.has(file)) {
      const content = readFileSync(join(migrationsDir, file), 'utf-8')
      await sql.unsafe(content)
      await sql`INSERT INTO _migrations (name) VALUES (${file})`
      console.log(`Applied migration: ${file}`)
    }
  }
}
