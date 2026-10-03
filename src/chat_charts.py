"""Declarative chart contract shared by all Python chat providers.

Keep the protocol in sync with app/renderer/src/lib/chatChart.ts.
The renderer validates data and supplies all chart components itself.
"""

CHART_INSTRUCTIONS = '''When the user asks for a chart and the supplied notes contain enough numeric data, include a fenced steno-chart JSON block with this shape:
{"type":"bar","title":"Chart title","xLabel":"Category","yLabel":"Count","data":[{"label":"Example","value":3}]}
Use type bar for comparisons or line for ordered trends. Use at most 100 data points, finite numbers between -1e12 and 1e12, and labels of at most 120 characters. Use only these fields. Keep the JSON under 50000 characters and close the code fence.
Chart only numbers explicitly present in, or directly countable from, the supplied notes. Never invent values or treat missing data as zero. Explain the source, units, scope, and any omissions in the surrounding text. If there is not enough numeric evidence, explain that instead of drawing a chart. Do not produce charts unless requested.'''
