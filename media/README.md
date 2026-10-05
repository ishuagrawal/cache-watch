# media

| File | What it is |
| --- | --- |
| [cache-watch-states.png](./cache-watch-states.png) | Every state of the band, captured in the Claude desktop app |
| [compose.py](./compose.py) | Lays the captures out into that image |

Nothing in the image is mocked up. Each state is a screenshot of the real Claude desktop app with cache-watch loaded. `/cachewatch demo <state>` puts the band in that state, and macOS's `screencapture -l <window id>` grabs only the Claude window. The working state is from a real turn. The numbers are the demo's: Opus 5.5 with about 190k tokens of context on a 1-hour cache.

## Regenerate

Needs Python 3 with Pillow. The text is set in Anthropic Sans, loaded from the installed Claude desktop app (`/Applications/Claude.app`).

1. Show each state with `/cachewatch demo <state>` and capture the Claude window to `<dir>/<state>.png`, keeping the prompt box empty. Use `warm`, `expiring`, `expired`, `model` and `compacted`. Capture `working.png` while Claude is mid-turn.
2. Run:

```bash
python3 compose.py <dir> cache-watch-states.png
```

The crops are measured from the bottom of the window, so capture at the same window size and leave banners such as usage notices dismissed or in place across all six.
