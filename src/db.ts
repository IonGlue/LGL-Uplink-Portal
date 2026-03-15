import postgres from 'postgres'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

export function createDb(url: string, maxConnections: number) {
  return postgres(url, { max: maxConnections })
}

export async function runMigrations(sql: postgres.Sql) {
  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `

  // Check both our tracking table and sqlx's (for Rust→TS migration compatibility)
  const applied = await sql`SELECT name FROM _migrations`
  const appliedSet = new Set(applied.map((r) => r.name))

  // Also check if sqlx migration table exists and import its entries
  try {
    const sqlxApplied = await sql`SELECT description FROM _sqlx_migrations ORDER BY version`
    for (const row of sqlxApplied) {
      // sqlx stores description like "create organizations" with spaces
      // Normalize to underscores to match against filenames
      appliedSet.add(row.description.replace(/ /g, '_'))
    }
  } catch {
    // _sqlx_migrations doesn't exist — that's fine
  }

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
    // Check against both our tracking and sqlx's descriptions
    // sqlx description = filename without extension and number prefix, e.g. "create_organizations"
    const description = file.replace(/^\d+_/, '').replace(/\.sql$/, '')
    if (!appliedSet.has(file) && !appliedSet.has(description)) {
      const content = readFileSync(join(migrationsDir, file), 'utf-8')
      await sql.unsafe(content)
      await sql`INSERT INTO _migrations (name) VALUES (${file})`
      console.log(`Applied migration: ${file}`)
    }
  }
}
