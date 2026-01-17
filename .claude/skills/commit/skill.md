# Skill: Smart Git Commit

Use this skill when the user runs `/commit` or asks to commit changes.

## Instructions

1.  **Analyze Context**:
    - Run `git status` to identify modified, added, or deleted files.
    - Run `git diff` to inspect the actual code changes in unstaged files.
    - Run `git diff --cached` to inspect changes in staged files.

2.  **Stage Changes**:
    - If there are unstaged changes, run `git add -A` to stage all changes (unless the user specifically asked to partial commit).

3.  **Generate Commit Message**:
    - Analyze the diffs to understand the *intent* of the changes.
    - Draft a commit message following the **Conventional Commits** specification:
      ```
      <type>(<scope>): <description>

      [optional body]
      ```
    - **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.
    - **Scope**: (Optional) The module or file affected (e.g., `proxy`, `ui`, `deps`).
    - **Description**: Concise summary in imperative mood (e.g., "add support for...", not "added").

4.  **Execute Commit**:
    - Run `git commit -m "generated_message"`.
    - If the message has a body, use multiple `-m` flags or a heredoc.

5.  **Report**:
    - Inform the user of the commit message used and the result.
