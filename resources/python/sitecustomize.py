"""Trusted plotting defaults; only the bundled helper directory enters PYTHONPATH."""
import os
os.environ.setdefault('MPLBACKEND', 'Agg')
if os.environ.get('DATA_AGENT_FONT'):
    import matplotlib
    from matplotlib import font_manager
    font_manager.fontManager.addfont(os.environ['DATA_AGENT_FONT'])
    matplotlib.rcParams['font.family'] = font_manager.FontProperties(fname=os.environ['DATA_AGENT_FONT']).get_name()
    matplotlib.rcParams['axes.unicode_minus'] = False
