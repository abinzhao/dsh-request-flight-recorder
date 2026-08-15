import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_PACKAGE = /^@deepseek-ai\/dsh-/u
const EXACT_RC = /^0\.1\.0-rc\.\d+$/u

export async function readManifest(root = process.cwd()) {
  return JSON.parse(
    await readFile(pathToFileURL(join(root, 'package.json')), 'utf8'),
  )
}

export async function readPeerDependencies(root = process.cwd()) {
  const manifest = await readManifest(root)
  return Object.fromEntries(
    Object.entries(manifest.peerDependencies ?? {})
      .filter(([name]) => (
        name === '@deepseek-ai/cordis' || DSH_PACKAGE.test(name)
      )),
  )
}

export async function readSupportedDshVersion(root = process.cwd()) {
  const peers = await readPeerDependencies(root)
  const versions = new Set(
    Object.entries(peers)
      .filter(([name]) => DSH_PACKAGE.test(name))
      .map(([, version]) => version),
  )
  if (versions.size !== 1) {
    throw new Error(
      `DSH peer versions must be identical: ${[...versions].join(', ')}`,
    )
  }
  const [version] = versions
  if (typeof version !== 'string' || !EXACT_RC.test(version)) {
    throw new Error(
      `DSH peer version must be one exact RC: ${String(version)}`,
    )
  }
  return version
}
