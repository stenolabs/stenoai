"""Declarative chart contract shared by all Python chat providers.

Keep the protocol in sync with app/renderer/src/lib/chatChart.ts.
The renderer validates data and supplies all chart components itself.
"""

CHART_INSTRUCTIONS = '''When the user asks for a chart and the supplied notes contain enough numeric data, include a fenced steno-chart JSON block. Examples:
One series: {"type":"bar","title":"Actions by meeting","xLabel":"Meeting","yLabel":"Actions","data":[{"label":"Planning","value":3}]}
Several series: {"type":"bar","title":"Tickets by day","xLabel":"Day","yLabel":"Tickets","stacked":true,"series":[{"name":"Open","data":[{"label":"Mon","value":3}]},{"name":"Closed","data":[{"label":"Mon","value":2}]}]}
Shares: {"type":"pie","title":"Time by topic","data":[{"label":"Hiring","value":20}]}
Scatter: {"type":"scatter","title":"Length vs actions","xLabel":"Minutes","yLabel":"Actions","data":[{"x":30,"y":4,"label":"Planning"}]}
Types: bar for comparisons (add "orientation":"horizontal" for long labels, "stacked":true for parts of a whole), line or area for ordered trends (area may be stacked), pie or donut for shares of one total (data only, values 0 or more), radar for 3 or more categories, scatter for two numbers per item, table for exact values. Use data for one series or series for several, never both.
Use at most 8 series of at most 100 points, finite numbers between -1e12 and 1e12, and labels of at most 120 characters. Use only these fields. Keep the JSON under 50000 characters and close the code fence.
Chart only numbers explicitly present in, or directly countable from, the supplied notes. Never invent values or treat missing data as zero. Explain the source, units, scope, and any omissions in the surrounding text. If there is not enough numeric evidence, explain that instead of drawing a chart. Do not produce charts unless requested.'''
