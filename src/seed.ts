import { loadConfig } from './config.js'
import { createDb, runMigrations } from './db.js'
import { hashPassword } from './auth/password.js'

async function main() {
  const args = process.argv.slice(2)
  const configPath = args[0] || 'config/ingest.example.toml'

  function getArg(flag: string, defaultVal: string): string {
    const idx = args.indexOf(flag)
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal
  }

  const orgName = getArg('--org', 'Default Org')
  const email = getArg('--admin-email', 'admin@example.com')
  const password = getArg('--admin-password', 'changeme')

  const config = loadConfig(configPath)
  const db = createDb(config.database.url, config.database.max_connections)
  await runMigrations(db)

  const slug = orgName.toLowerCase().replace(/ /g, '-')
  const [org] = await db`
    INSERT INTO organizations (name, slug)
    VALUES (${orgName}, ${slug})
    RETURNING *
  `
  console.log(`created org: ${org.name} (${org.id})`)

  const passwordHash = await hashPassword(password)
  const [user] = await db`
    INSERT INTO users (email, password_hash, display_name, role, org_id)
    VALUES (${email}, ${passwordHash}, 'Admin', 'admin', ${org.id})
    RETURNING *
  `
  console.log(`created admin user: ${user.email} (${user.id})`)

  console.log('\nSeed complete.')
  console.log(`  Org:   ${org.name} / ${org.id}`)
  console.log(`  Admin: ${user.email} / ${user.id}`)

  await db.end()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
