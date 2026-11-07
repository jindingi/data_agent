import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function reportFixture(mode = 'comparison', script = '') {
  const lib = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8');
  const intro =
    mode === 'narrative'
      ? '<article><h1>趋势解释</h1><p>这是合成数据的趋势说明。</p></article>'
      : '<h1>群体比较</h1>';
  return `<!doctype html><meta charset="utf-8"><title>交互报告</title>
<style>body{font:16px system-ui;margin:24px;color:#17212b;background:white}#chart{height:360px}article{max-width:650px}button,select{font:inherit}footer{margin-top:900px}</style>
${intro}<label>地区 <select id="region"><option value="all">全部</option><option value="east">华东</option></select></label><button id="reset">重置</button><output id="total">60</output><div id="chart"></div><table><tbody id="rows"><tr><td>全部</td><td>60</td></tr></tbody></table><footer id="tail">报告尾部</footer><a href="#tail">跳至尾部</a>
<script>${lib}</script><script>
const chart=echarts.init(document.getElementById('chart'));
function render(){const east=document.getElementById('region').value==='east';const values=east?[10,20]:[20,40];
document.getElementById('total').textContent=String(values.reduce((a,b)=>a+b,0));
document.getElementById('rows').textContent=east?'华东 30':'全部 60';
chart.setOption({animation:false,tooltip:{renderMode:'richText'},dataZoom:[{type:'inside'}],xAxis:{type:'category',data:['一月','二月']},yAxis:{},series:[{type:${JSON.stringify(mode === 'narrative' ? 'line' : 'bar')},data:values}]});}
document.getElementById('region').addEventListener('change',render);
document.getElementById('reset').addEventListener('click',()=>{document.getElementById('region').value='all';render()});
new ResizeObserver(()=>chart.resize()).observe(document.getElementById('chart'));render();${script}
</script>`;
}
