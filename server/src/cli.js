#!/usr/bin/env node
// 命令行：对两份 Markdown 文件运行语义差异，输出摘要与 Markdown 报告。
// 用法：node server/src/cli.js old.md new.md [--rule rule-v1] [--budget 40000] [--json]
import fs from 'node:fs'
import { compareDocuments } from '../../shared/semantic/diff.js'
import { renderMarkdownReport } from '../../shared/report/report.js'

const args = process.argv.slice(2)
const files = args.filter((a) => !a.startsWith('--'))
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i !== -1 && args[i + 1] ? args[i + 1] : def
}
if (files.length < 2) {
  console.error('usage: cli.js <old.md> <new.md> [--rule v] [--budget n] [--json]')
  process.exit(1)
}
const result = compareDocuments(fs.readFileSync(files[0], 'utf8'), fs.readFileSync(files[1], 'utf8'), {
  ruleVersion: opt('rule', 'rule-default'),
  budgetCells: Number(opt('budget', 40000))
})
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(
    renderMarkdownReport({
      result,
      oldVersion: { versionId: files[0] },
      newVersion: { versionId: files[1] }
    })
  )
}
