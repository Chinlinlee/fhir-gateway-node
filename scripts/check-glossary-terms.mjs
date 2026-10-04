#!/usr/bin/env node
/**
 * 擋下 CONTEXT.md `_Avoid_` 裡的禁用同義詞出現在程式碼中。
 *
 * 為什麼需要這個檢查：`CONTEXT.md` 每個詞條下面都有 `_Avoid_:` 行，列出**會誤導的別名**。
 * 那是給 agent 看的，但它不像 lint 那樣會擋人——寫出一個和詞彙表撞名的識別字時，
 * 沒有任何東西會喊停。Standards review 抓到過 `LaunchIdField` / `getLaunchIdOrFail`：
 * 那是「launch id」在 glossary 裡已經有專指（EHR 的 opaque handle），而這兩個名字實際上
 * 指的是病人參照。
 *
 * 掃描範圍只有 `src/` 與 `tests/` 的 TypeScript。刻意不掃 docs/：README 在解釋
 * 「Access AuditEvent 不是 access log」時本來就會用到那些字。
 *
 * 豁免：見 `AMBIGUOUS_TERMS`。glossary 禁的是「用這個詞指稱那個概念」，不是禁用這個英文字。
 * `const target = new URL(...)` 是合法程式碼，所以那兩個詞不能機械擋——硬擋的結果是這個檢查
 * 被關掉。豁免會在輸出裡印出來，改詞彙表時看得到。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const GLOSSARY = "CONTEXT.md";
const SCAN_DIRS = ["src", "tests"];

/**
 * 與常用英文詞重疊、無法機械判定的禁用詞。
 * 每個都附上原因，改動時請一併更新 CONTEXT.md 的說明。
 */
const AMBIGUOUS_TERMS = new Map([
    // Audience 詞條。禁的是「把 audience 叫做 target」，不是禁用 target 這個字——
    // HTTP 轉發層到處都有合法的 `target` 變數。
    ["target", "Audience 詞條；HTTP 轉發層有同名合法變數"],
    ["resource indicator", "Audience 詞條；OAuth 規格用語本身就是這個字"],
]);

const glossary = readFileSync(GLOSSARY, "utf8");

/**
 * 從 glossary 抽出禁用詞。先去掉括號補充說明，再以頓號／逗號切分——
 * 順序很重要：說明裡本身就有頓號，先切會把括號切碎。
 */
function extractAvoidTerms(markdown) {
    const terms = new Map();
    for (const line of markdown.split("\n")) {
        const match = /^_Avoid_[:：]\s*(.+)$/.exec(line.trim());
        if (match === null) continue;
        const withoutNotes = match[1].replace(/（[^）]*）/g, "");
        for (const raw of withoutNotes.split(/[、，,]/)) {
            const term = raw.trim();
            if (term.length === 0) continue;
            terms.set(term, terms.get(term) ?? null);
        }
    }
    return terms;
}

/** 遞迴收集副檔名符合的檔案。 */
function collectFiles(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            collectFiles(path, out);
        } else if (/\.tsx?$/.test(entry)) {
            out.push(path);
        }
    }
    return out;
}

const allTerms = extractAvoidTerms(glossary);
const enforced = [...allTerms.keys()].filter((term) => !AMBIGUOUS_TERMS.has(term));
const skipped = [...allTerms.keys()].filter((term) => AMBIGUOUS_TERMS.has(term));

if (enforced.length === 0) {
    console.error(`${GLOSSARY} 沒有解析到任何 _Avoid_ 詞——詞彙表格式變了，這個檢查等於失效。`);
    process.exit(1);
}

const violations = [];
for (const dir of SCAN_DIRS) {
    for (const file of collectFiles(dir)) {
        readFileSync(file, "utf8")
            .split("\n")
            .forEach((line, index) => {
                const haystack = line.toLowerCase();
                for (const term of enforced) {
                    if (haystack.includes(term.toLowerCase())) {
                        violations.push({
                            file: relative(process.cwd(), file),
                            line: index + 1,
                            term,
                            text: line.trim(),
                        });
                    }
                }
            });
    }
}

console.log(`[glossary] 擋 ${enforced.length} 個禁用詞，掃過 ${SCAN_DIRS.join("、")}`);
console.log(`[glossary] 跳過 ${skipped.length} 個（需人工判斷）：`);
for (const term of skipped) {
    console.log(`[glossary]   - ${term} — ${AMBIGUOUS_TERMS.get(term)}`);
}

if (violations.length > 0) {
    console.error(`\n[glossary] ${violations.length} 處使用 CONTEXT.md 禁止的同義詞：`);
    for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  「${v.term}」  ${v.text}`);
    }
    console.error("\n用 CONTEXT.md 定義的詞。若詞彙表本身需要調整，改 CONTEXT.md 而不是繞過這裡。");
    process.exit(1);
}
