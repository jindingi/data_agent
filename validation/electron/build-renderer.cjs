require('esbuild').buildSync({entryPoints:['markdown.jsx'],bundle:true,minify:true,format:'iife',outfile:'markdown-bundle.js',define:{'process.env.NODE_ENV':JSON.stringify('production')}});
