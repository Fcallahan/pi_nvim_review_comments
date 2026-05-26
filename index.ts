import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function hasCommand(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REVIEW_PREFIX_RE = /^\s*(?:#\s*)?REVIEW(?::|\s+)\s?(.*)$/;
const MAX_DIFF_BYTES = 1_500_000;
const MAX_UNTRACKED_FILE_BYTES = 250_000;

interface ReviewContext {
  isIdle(): boolean;
  hasUI: boolean;
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
    custom<T>(factory: (tui: { stop(): void; start(): void; requestRender(force?: boolean): void }, theme: unknown, kb: unknown, done: (value: T) => void) => unknown): Promise<T>;
  };
}

interface ParsedArgs {
  scope: "all" | "staged" | "unstaged";
  paths: string[];
  help: boolean;
  contextLines: number;
}

interface ChangedFile {
  path: string;
  status: string;
}

interface ReviewFile {
  reviewPath: string;
  vimScriptPath: string;
  firstDiffLine: number;
  hasChanges: boolean;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("nvim-review", {
    description: "Review full-context git diffs in nvim/vim and send inline comments back to the agent",
    async handler(args: string, ctx: ReviewContext) {
      await runNvimReview(pi, args, ctx);
    },
  });
}

export async function runNvimReview(pi: ExtensionAPI, args: string, ctx: ReviewContext): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    ctx.ui.notify("Usage: /nvim-review [--staged|--unstaged] [--context=N] [path ...]", "info");
    return;
  }

  if (!isGitRepo(ctx.cwd)) {
    ctx.ui.notify("/nvim-review requires a git repository", "error");
    return;
  }

  const editor = resolveEditor();
  if (!editor) {
    ctx.ui.notify("/nvim-review requires nvim or vim, or set PI_REVIEW_EDITOR/VISUAL/EDITOR", "error");
    return;
  }

  const review = createReviewDiff(ctx.cwd, parsed);
  if (!review.hasChanges) {
    ctx.ui.notify("No changes found to review", "info");
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify(`Review diff created: ${review.reviewPath}`, "info");
    return;
  }

  const originalReviewContent = readFileSync(review.reviewPath, "utf-8");

  const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _kb, done) => {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");

    const command = buildEditorCommand(editor, review.reviewPath, review.vimScriptPath, review.firstDiffLine);
    const shell = process.env.SHELL || "/bin/sh";
    const result = spawnSync(shell, ["-lc", command], {
      cwd: ctx.cwd,
      stdio: "inherit",
      env: process.env,
    });

    tui.start();
    tui.requestRender(true);
    done(result.status ?? 1);
    return { render: () => [], invalidate: () => {} };
  });

  if (exitCode !== 0) {
    ctx.ui.notify(`/nvim-review editor exited with code ${exitCode}`, "warning");
    return;
  }

  const comments = extractInlineReviewComments(readFileSync(review.reviewPath, "utf-8"), originalReviewContent);
  if (!comments.trim()) {
    ctx.ui.notify(`No REVIEW: comments found. Review saved at ${relative(ctx.cwd, review.reviewPath)}`, "info");
    return;
  }

  const message = `Please address these inline review comments from my nvim diff review.\n\n${comments.trim()}\n\nReview diff: ${relative(ctx.cwd, review.reviewPath)}`;
  if (ctx.isIdle()) {
    pi.sendUserMessage(message);
    ctx.ui.notify("Review comments sent to agent", "success");
  } else {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("Review comments queued for agent", "info");
  }
}

function parseArgs(args: string): ParsedArgs {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let scope: ParsedArgs["scope"] = "all";
  const paths: string[] = [];
  let help = false;
  let contextLines = 999_999;

  for (const part of parts) {
    if (part === "--help" || part === "-h") help = true;
    else if (part === "--staged" || part === "--cached") scope = "staged";
    else if (part === "--unstaged" || part === "--worktree") scope = "unstaged";
    else if (part.startsWith("--context=")) {
      const n = Number(part.slice("--context=".length));
      if (Number.isFinite(n) && n >= 0) contextLines = Math.floor(n);
    } else paths.push(part);
  }

  return { scope, paths, help, contextLines };
}

function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

function createReviewDiff(cwd: string, parsed: ParsedArgs): ReviewFile {
  const reviewDir = join(cwd, ".pi", "reviews");
  mkdirSync(reviewDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reviewPath = join(reviewDir, `nvim-review-${stamp}.diff`);
  const vimScriptPath = join(reviewDir, `nvim-review-${stamp}.vim`);
  const status = safeGit(cwd, ["status", "--short", "-uall"]);
  const changedFiles = getChangedFiles(cwd, parsed.paths, parsed.scope);
  const trackedDiff = collectFullContextDiff(cwd, parsed);
  const untrackedDiff = parsed.scope === "staged" ? "" : collectUntrackedDiff(cwd, changedFiles);
  const diff = [trackedDiff, untrackedDiff].filter((part) => part.trim()).join("\n");
  const hasChanges = Boolean(diff.trim() || changedFiles.length > 0);

  const rendered = renderReviewDiff({ cwd, parsed, status, changedFiles, diff });
  writeFileSync(reviewPath, rendered.content, "utf-8");
  writeFileSync(vimScriptPath, renderReviewVimScript(), "utf-8");

  return { reviewPath, vimScriptPath, firstDiffLine: rendered.firstDiffLine, hasChanges };
}

function collectFullContextDiff(cwd: string, parsed: ParsedArgs): string {
  const pathArgs = buildPathArgs(parsed.paths);
  const context = `--unified=${parsed.contextLines}`;
  const args =
    parsed.scope === "staged"
      ? ["diff", "--no-color", context, "--cached", ...pathArgs]
      : parsed.scope === "unstaged"
        ? ["diff", "--no-color", context, ...pathArgs]
        : ["diff", "--no-color", context, "HEAD", ...pathArgs];

  let output = safeGit(cwd, args, MAX_DIFF_BYTES + 10_000);
  if (!output.trim() && parsed.scope === "all") {
    const staged = safeGit(cwd, ["diff", "--no-color", context, "--cached", ...pathArgs], MAX_DIFF_BYTES);
    const unstaged = safeGit(cwd, ["diff", "--no-color", context, ...pathArgs], MAX_DIFF_BYTES);
    output = [staged, unstaged].filter((part) => part.trim()).join("\n");
  }

  return truncateText(output, MAX_DIFF_BYTES, "diff");
}

function collectUntrackedDiff(cwd: string, files: ChangedFile[]): string {
  const sections: string[] = [];
  for (const file of files.filter((f) => f.status === "??" || f.status === "?")) {
    const abs = join(cwd, file.path);
    if (!existsSync(abs)) continue;
    const stat = statSync(abs);
    if (!stat.isFile()) continue;
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      sections.push(`diff --git a/${file.path} b/${file.path}`);
      sections.push("new file mode 100644");
      sections.push("--- /dev/null");
      sections.push(`+++ b/${file.path}`);
      sections.push(`@@ -0,0 +1,1 @@`);
      sections.push(`+[untracked file omitted: ${stat.size} bytes exceeds ${MAX_UNTRACKED_FILE_BYTES} byte limit]`);
      continue;
    }

    const buf = readFileSync(abs);
    if (buf.includes(0)) {
      sections.push(`diff --git a/${file.path} b/${file.path}`);
      sections.push("new file mode 100644");
      sections.push("--- /dev/null");
      sections.push(`+++ b/${file.path}`);
      sections.push(`@@ -0,0 +1,1 @@`);
      sections.push("+[binary untracked file omitted]");
      continue;
    }

    const content = buf.toString("utf-8").replace(/\r\n/g, "\n");
    const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
    sections.push(`diff --git a/${file.path} b/${file.path}`);
    sections.push("new file mode 100644");
    sections.push("--- /dev/null");
    sections.push(`+++ b/${file.path}`);
    sections.push(`@@ -0,0 +1,${Math.max(lines.length, 1)} @@`);
    for (const line of lines) sections.push(`+${line}`);
    if (!content.endsWith("\n")) sections.push("\\ No newline at end of file");
  }

  return sections.join("\n");
}

function getChangedFiles(cwd: string, pathFilters: string[], scope: ParsedArgs["scope"]): ChangedFile[] {
  const output = safeGit(cwd, ["status", "--porcelain=v1", "-z", "-uall"]);
  const entries = output.split("\0");
  const files: ChangedFile[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;

    const xy = entry.slice(0, 2);
    let filePath = entry.slice(3);
    if ((xy[0] === "R" || xy[0] === "C") && entries[i + 1]) {
      i += 1;
      filePath = entries[i];
    }

    if (isInternalReviewPath(filePath)) continue;
    if (!matchesScope(xy, scope)) continue;
    if (!matchesPathFilters(filePath, pathFilters)) continue;
    files.push({ path: filePath, status: xy.trim() || "modified" });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function buildPathArgs(paths: string[]): string[] {
  if (paths.length > 0) return ["--", ...paths];
  return ["--", ".", ":(exclude).pi/reviews/**"];
}

function isInternalReviewPath(filePath: string): boolean {
  return filePath === ".pi/reviews" || filePath.startsWith(".pi/reviews/");
}

function matchesScope(xy: string, scope: ParsedArgs["scope"]): boolean {
  if (scope === "all") return true;
  if (scope === "staged") return xy[0] !== " " && xy[0] !== "?";
  return xy[1] !== " " || xy[0] === "?";
}

function matchesPathFilters(filePath: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => filePath === filter || filePath.startsWith(`${filter}/`) || filter.startsWith(`${filePath}/`));
}

function renderReviewDiff(input: { cwd: string; parsed: ParsedArgs; status: string; changedFiles: ChangedFile[]; diff: string }): { content: string; firstDiffLine: number } {
  const lines: string[] = [];
  lines.push("# Pi nvim diff review");
  lines.push("#");
  lines.push("# This is a full-context diff for the current worktree changes.");
  lines.push("# Add comments with <leader>c (Space+c unless you already set mapleader), or manually add:");
  lines.push("# REVIEW: your comment here");
  lines.push("#");
  lines.push("# Save and quit. Pi extracts REVIEW comments with nearby file/line context and sends them to the agent.");
  lines.push("# You can use nvim search/jumps/folds as usual. This file is safe to edit; it is not applied as a patch.");
  lines.push("#");
  lines.push(`# cwd: ${input.cwd}`);
  lines.push(`# generated: ${new Date().toISOString()}`);
  lines.push(`# scope: ${input.parsed.scope}`);
  lines.push(`# context: ${input.parsed.contextLines}`);
  if (input.parsed.paths.length > 0) lines.push(`# paths: ${input.parsed.paths.join(", ")}`);
  lines.push("#");
  lines.push("# Changed files:");
  if (input.changedFiles.length === 0) lines.push("#   none");
  for (const file of input.changedFiles) lines.push(`#   ${file.status.padEnd(2)} ${file.path}`);
  lines.push("#");
  lines.push("# Git status:");
  for (const line of (input.status || "clean").trimEnd().split("\n")) lines.push(`#   ${line}`);
  lines.push("#");
  lines.push("# ---- diff starts below ----");
  const firstDiffLine = lines.length + 1;
  lines.push(input.diff || "# No tracked-file diff for this scope.");
  lines.push("");

  return { content: lines.join("\n"), firstDiffLine };
}

function renderReviewVimScript(): string {
  return String.raw`
if !exists("mapleader")
  let mapleader = " "
endif

function! PiReviewCommentAt(line1, line2) abort
  let l:comment = input('Review comment: ')
  if empty(l:comment)
    echo 'Pi review comment cancelled'
    return
  endif

  let l:range = a:line1 == a:line2 ? 'line ' . a:line1 : 'lines ' . a:line1 . '-' . a:line2
  let l:payload = a:line1 == a:line2 ? l:comment : '[selected diff lines ' . a:line1 . '-' . a:line2 . '] ' . l:comment
  let l:width = max([42, strdisplaywidth(l:comment) + 6, strdisplaywidth(l:range) + 18])
  let l:top = '# ┌─ PI REVIEW @ ' . l:range . ' ' . repeat('─', max([1, l:width - strdisplaywidth('┌─ PI REVIEW @ ' . l:range . ' ')]))
  let l:bottom = '# └' . repeat('─', max([1, l:width - 1]))
  let l:box = [l:top, '# │ ' . l:comment, '# REVIEW: ' . l:payload, l:bottom]
  call append(a:line2, l:box)
  echo 'Pi review comment added. Save and quit (:wq) to send.'
endfunction

function! PiReviewJump(pattern, flags) abort
  call search(a:pattern, a:flags)
  normal! zz
endfunction

nnoremap <buffer> <leader>c :call PiReviewCommentAt(line('.'), line('.'))<CR>
xnoremap <buffer> <leader>c :<C-U>call PiReviewCommentAt(line("'<"), line("'>"))<CR>
nnoremap <buffer> gc :call PiReviewCommentAt(line('.'), line('.'))<CR>
xnoremap <buffer> gc :<C-U>call PiReviewCommentAt(line("'<"), line("'>"))<CR>
nnoremap <buffer> ]h :call PiReviewJump('^@@', 'W')<CR>
nnoremap <buffer> [h :call PiReviewJump('^@@', 'bW')<CR>
nnoremap <buffer> ]f :call PiReviewJump('^diff --git', 'W')<CR>
nnoremap <buffer> [f :call PiReviewJump('^diff --git', 'bW')<CR>
setlocal filetype=diff
setlocal foldmethod=syntax
normal! zR
echo 'Pi review: ]h/[h hunks, ]f/[f files, <leader>c or gc comment, :wq sends.'
`;
}

function extractInlineReviewComments(content: string, originalContent = ""): string {
  const originalReviewLines = new Map<string, number>();
  for (const line of originalContent.split("\n")) {
    if (!line.match(REVIEW_PREFIX_RE)) continue;
    originalReviewLines.set(line, (originalReviewLines.get(line) ?? 0) + 1);
  }

  const comments: string[] = [];
  let currentFile = "";
  let newLine: number | undefined;
  let pendingFileFromDiff = "";

  for (const rawLine of content.split("\n")) {
    const commentMatch = rawLine.match(REVIEW_PREFIX_RE);
    if (commentMatch) {
      const originalCount = originalReviewLines.get(rawLine) ?? 0;
      if (originalCount > 0) {
        originalReviewLines.set(rawLine, originalCount - 1);
        continue;
      }

      const text = commentMatch[1]?.trim() ?? "";
      if (!text) continue;
      const location = currentFile ? `${currentFile}${newLine !== undefined ? `:${newLine}` : ""}` : "general";
      comments.push(`- ${location}: ${text}`);
      continue;
    }

    const diffMatch = rawLine.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (diffMatch) {
      pendingFileFromDiff = diffMatch[2] ?? diffMatch[1] ?? "";
      currentFile = pendingFileFromDiff;
      newLine = undefined;
      continue;
    }

    const plusFileMatch = rawLine.match(/^\+\+\+ b\/(.*)$/);
    if (plusFileMatch) {
      currentFile = plusFileMatch[1] ?? pendingFileFromDiff;
      newLine = undefined;
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1]);
      continue;
    }

    if (newLine === undefined) continue;
    if (rawLine.startsWith("+++ ") || rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("+")) newLine += 1;
    else if (rawLine.startsWith(" ")) newLine += 1;
  }

  return comments.join("\n").trim();
}

function resolveEditor(): string | undefined {
  const configured = process.env.PI_REVIEW_EDITOR || process.env.VISUAL || process.env.EDITOR;
  if (configured?.trim()) return configured.trim();
  if (hasCommand("nvim")) return "nvim";
  if (hasCommand("vim")) return "vim";
  return undefined;
}

function buildEditorCommand(editor: string, reviewPath: string, vimScriptPath: string, firstDiffLine: number): string {
  const firstWord = editor.trim().split(/\s+/)[0] || editor;
  const base = basename(firstWord);
  const isVim = base === "nvim" || base === "vim" || base === "vi";

  if (isVim) {
    return `${editor} -S ${shellQuote(vimScriptPath)} +${firstDiffLine} ${shellQuote(reviewPath)}`;
  }

  return `${editor} ${shellQuote(reviewPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function git(cwd: string, args: string[], maxBuffer = 5_000_000): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

function safeGit(cwd: string, args: string[], maxBuffer = 5_000_000): string {
  try {
    return git(cwd, args, maxBuffer);
  } catch {
    return "";
  }
}

function truncateText(text: string, maxBytes: number, label: string): string {
  const bytes = Buffer.byteLength(text, "utf-8");
  if (bytes <= maxBytes) return text;
  const truncated = text.slice(0, maxBytes);
  return `${truncated}\n\n# [${label} truncated at ${maxBytes} bytes; use --context=N or git/nvim directly for complete output.]\n`;
}
