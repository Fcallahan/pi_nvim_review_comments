# pi_nvim_review_comments

A Pi extension for reviewing current git changes in `nvim`/`vim` as a full-context diff, adding inline review comments, and sending those comments back to the Pi agent when you save and quit.

## What it does

- Adds `/nvim-review` to Pi.
- Generates one `.diff` review file under `.pi/reviews/`.
- Includes all current changes with full-file context by default.
- Includes untracked text files as new-file diffs.
- Opens the review diff in `nvim` or `vim`.
- Provides review mappings:
  - `]h` / `[h` next/previous hunk
  - `]f` / `[f` next/previous file
  - `<leader>c` or `gc` add a review comment
- Supports visual selection before commenting.
- Inserts a visible inline review box in the diff.
- On `:wq`, extracts `REVIEW:` comments and sends them to the Pi agent.

## Dependencies

Required:

- [Pi coding agent](https://pi.dev)
- `git`
- `nvim` or `vim`

Recommended for Pi/file review workflows:

- `bat`
- `git-delta`
- `glow`

Ubuntu/Debian/WSL:

```bash
sudo apt update
sudo apt install -y git neovim bat git-delta

# glow, if unavailable from your distro repo:
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor | sudo tee /etc/apt/keyrings/charm.gpg >/dev/null
echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list
sudo apt update
sudo apt install -y glow
```

macOS:

```bash
brew install neovim bat git-delta glow
```

## One-shot install

```bash
pi install git:github.com/Fcallahan/pi_nvim_review_comments
```

Then restart Pi or run:

```text
/reload
```

## Local install from clone

```bash
git clone git@github.com:Fcallahan/pi_nvim_review_comments.git ~/pi_nvim_review_comments
```

Add it to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/pi_nvim_review_comments"
  ]
}
```

Then in Pi:

```text
/reload
```

## Usage

Open a review for all current changes:

```text
/nvim-review
```

Review only staged changes:

```text
/nvim-review --staged
```

Review only unstaged/worktree changes:

```text
/nvim-review --unstaged
```

Limit context if the full-context diff is too large:

```text
/nvim-review --context=80
```

Review specific paths:

```text
/nvim-review src/foo.ts README.md
```

## Inside nvim/vim

Navigation:

```text
]h    next hunk
[h    previous hunk
]f    next file diff
[f    previous file diff
```

Add a comment on the current line:

```text
<leader>c
```

If you have not set `mapleader`, that is usually:

```text
Space+c
```

Alternative mapping:

```text
gc
```

Comment on a block:

1. Press `V` to start visual-line selection.
2. Select lines with `j`/`k`.
3. Press `Space+c` or `gc`.
4. Type the comment and press Enter.

The extension inserts a visible inline box, for example:

```diff
# ┌─ PI REVIEW @ line 42 ─────────────
# │ this needs a null check
# REVIEW: this needs a null check
# └───────────────────────────────────
```

Save and quit:

```vim
:wq
```

Pi extracts the `REVIEW:` comments, attaches nearby file/line context, and sends them to the agent.

## Editor selection

The extension uses the first available editor from:

1. `PI_REVIEW_EDITOR`
2. `VISUAL`
3. `EDITOR`
4. `nvim`
5. `vim`

Example:

```bash
export PI_REVIEW_EDITOR=nvim
```

## Notes

- Generated review files are written to `.pi/reviews/` in the current repo.
- `.pi/reviews/**` is excluded from future generated review diffs by default.
- The review `.diff` file is not applied as a patch; it is just a scratch review buffer.
- Comments are sent only after you save and quit the editor.
