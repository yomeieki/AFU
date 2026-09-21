#!/usr/bin/env node
// 仓库测试运行器：收集 apps/*/tests/**/*.test.ts 和 tests/**/*.test.ts，
// 用 esbuild 打包成 CJS 后交给 Node 自带的 node:test 执行。
// 不引入任何测试框架依赖。
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const require = (await import('node:module')).createRequire(import.meta.url)
const esbuild = require('esbuild')

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function findTestFiles() {
  const patterns = ['apps/*/tests/**/*.test.ts', 'tests/**/*.test.ts']
  const files = []
  for (const pattern of patterns) {
    files.push(...globSync(pattern, { cwd: rootDir }))
  }
  // 去重、排序，保证结果稳定
  return Array.from(new Set(files)).sort()
}

const testFiles = findTestFiles()

if (testFiles.length === 0) {
  console.error('未找到任何测试文件（apps/*/tests/**/*.test.ts、tests/**/*.test.ts），视为失败。')
  process.exit(1)
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afu-tests-'))
const bundled = []
let exitCode = 1

try {
  for (const rel of testFiles) {
    const absIn = path.join(rootDir, rel)
    const outFile = path.join(tmpDir, rel.replace(/[\\/]/g, '__').replace(/\.ts$/, '.cjs'))
    esbuild.buildSync({
      entryPoints: [absIn],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      absWorkingDir: rootDir,
      logLevel: 'silent',
    })
    bundled.push(outFile)
  }

  console.log(`收集到 ${testFiles.length} 个测试文件：`)
  for (const f of testFiles) console.log('  - ' + f)

  const result = spawnSync(process.execPath, ['--test', ...bundled], { stdio: 'inherit' })
  exitCode = result.status ?? 1
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

process.exitCode = exitCode
