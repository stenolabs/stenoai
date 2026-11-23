"""Declarative chart contract shared by all Python chat providers.

Keep the protocol in sync with app/renderer/src/lib/chatChart.ts.
The renderer validates data and supplies all chart components itself.
"""

CHART_INSTRUCTIONS = '''This app renders fenced steno-chart JSON blocks as real charts, so you can draw charts: never say you cannot display or create charts. When the user asks for a chart, graph or plot, answer with a short explanation and a steno-chart block. Examples:
One series: {"type":"bar","title":"Actions by meeting","xLabel":"Meeting","yLabel":"Actions","data":[{"label":"Planning","value":3}]}
Several series: {"type":"bar","title":"Tickets by day","xLabel":"Day","yLabel":"Tickets","stacked":true,"series":[{"name":"Open","data":[{"label":"Mon","value":3}]},{"name":"Closed","data":[{"label":"Mon","value":2}]}]}
Shares: {"type":"pie","title":"Time by topic","data":[{"label":"Hiring","value":20}]}
Scatter: {"type":"scatter","title":"Length vs actions","xLabel":"Minutes","yLabel":"Actions","data":[{"x":30,"y":4,"label":"Planning"}]}
Types: bar for comparisons (add "orientation":"horizontal" for long labels, "stacked":true for parts of a whole), line or area for ordered trends (area may be stacked), pie or donut for shares of one total (data only, values 0 or more), radar for 3 or more categories, scatter for two numbers per item, table for exact values. Use data for one series or series for several, never both.
Use at most 8 series of at most 100 points, finite numbers between -1e12 and 1e12, and labels of at most 120 characters. Use only these fields. Keep the JSON under 50000 characters and close the code fence.
Data rules: for questions about the user's meetings or notes, chart only numbers explicitly present in, or directly countable from, the supplied notes; never invent values or treat missing data as zero. Numbers the user gives in the conversation may be charted as given. For general-knowledge questions the notes do not cover, you may chart widely known public figures from your own knowledge: prefer a few well-known points, and say in the title or text that the values are approximate, from general knowledge rather than the user's notes, and the period covered. Explain the source, units, scope, and any omissions in the surrounding text. If there is not enough evidence, explain that instead of drawing a chart. Do not produce charts unless requested.'''
