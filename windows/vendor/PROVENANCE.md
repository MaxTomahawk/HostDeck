# Windows desktop source provenance

`WindowsCommander.Core` and `WindowsCommander.Windows` are copied from
Windows Commander commit `a5b33fed0994dc65782bf8cfb8e1168253098fcf`,
qualified in the local HostDeck source audit. The upstream project is
MIT-licensed; its unmodified license is retained in `LICENSE`. HostDeck's
private adapter calls only the desktop services it needs. HostDeck bounds UIA
enumeration to 500 returned elements in `UiAutomationService.cs`. This copy is not
the public MCP server and does not expose upstream operations directly.
