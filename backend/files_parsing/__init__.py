"""Host-side file parsing — extracts plain markdown from binary office/PDF
files so they can be safely fed to Claude Code's Read tool without crashing
the subprocess on garbage UTF-8."""
