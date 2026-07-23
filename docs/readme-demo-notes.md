# README demo observations

These notes came from the analysis-only Codex + K3 README review captured in `docs/images/codex-k3-handoff-demo.png`.

## Addressed in the README

- **Ambiguous handoff terminology.** “Handoff” referred both to K3 Markdown entering Codex's context and to an isolated Git commit. The README now calls these the **result handoff** and **edit handoff**.
- **The live panel and model-visible result looked like one path.** The new diagram separates event streaming to the panel from the later `await_k3_result` return to Codex.
- **The user benefit was implicit.** The screenshot caption now states that Codex receives the result without copying text from the panel.
- **The two user interfaces were under-documented.** Separate screenshots now show the embedded Codex controls and the same collaboration in Kimi Code Web.

## Follow-up opportunities

- **Window capture compatibility.** The Computer Use capture path failed for the Codex window with `SetIsBorderRequired failed: 0x80004002`; a read-only foreground-window capture was used instead. A stable panel export or host screenshot action would make documentation capture more reliable.
- **Kimi Code Web capture depends on browser integration.** The Chrome extension was initially absent, so the controlled browser could not inspect the authenticated Web view. After the extension was installed, the current local session could be captured directly.
- **Long bounded waits need stronger visible state.** The demo's single `await_k3_result` call occupied most of the task duration. The panel remained observable, but a clearer “Codex is waiting / result delivered” transition would make the event-driven behavior easier to understand.
- **Documentation screenshots need a privacy-safe workflow.** Raw app captures include task sidebars, local paths, session identifiers, and transient repository badges. The committed images were cropped or redacted; a reusable panel-only capture action would remove that manual step.
