<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Admin mode is password-gated (ADMIN_PASSWORD) on top of the user_roles admin role; unlock is an 8h HMAC token bound to the user id, kept in sessionStorage (cookies fail in the embedded preview). Why: role alone isn't enough for the sensitive global catalog.

- Product scope is event aggregation only; legacy badge/brand data stays stored but is not read or exposed. Why: historical data must remain recoverable while the active product stays focused.

# Agent rule (SWE standard, set by Ignacio 2026-10-27)

Precedence, highest first:
1. Ignacio's rules in this file and in the task prompt.
2. The stricter human gate. If two rules disagree about asking a person, the one that asks wins.
3. poteto-mode (pstack) for models, delegation and code workflow.

Code
- Use poteto-mode for features, root-cause bug fixes, autonomous runs and session pickup. Report failing-then-passing evidence. Use show-me-your-work for long or overnight runs.
- Push directly to `main` in small commits. This is Ignacio's standing grant of 2026-10-19 and it covers exactly that. Skip every pull request, worktree and PR-opening step in any playbook.
- Nothing goes live, is published, sent, posted or bought without Ignacio's own words. Draft it and stop. Never turn on a `*_PUBLISH_LIVE` flag.
- Commits, code and comments in English. Chat replies in Spanish, answer first, short and plain, with readable markdown.
- Every claim carries its evidence or is labelled measured, inferred or guess. Never invent data.

Web, directories, design and external review (hunter-mode principles, used as reference)
- Look with your own eyes: load the real URL, check phone and desktop widths, give the link.
- Source over memory. Reuse before build. No fat. Study the best examples before designing.
- Agent first for anything with an MCP or API surface.
- Do not name private brands or people in public output.
- For PRs to external awesome lists, draft the PR and review notes. Ignacio sends.
