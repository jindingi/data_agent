export const scenarios = {
  'J1-SALES': {
    files: {
      'sales.csv': 'month,region_id,sales\n2026-06,N,1000\n2026-07,N,800\n2026-08,N,700\n2026-06,S,500\n2026-07,S,550\n2026-08,S,600\n2026-06,W,200\n2026-07,W,150\n2026-08,W,100\n',
      'regions.csv': 'region_id,region_name\nN,北区\nS,南区\nW,西区\n',
    },
    task: '关联所选销售表与地区名称表，分析数据中最新三个月的各地区销售变化。金额单位为元，月份均为完整月。分别按首末月的绝对下降金额和下降比例比较，说明下降最明显的地区、每月变化、假设与限制。生成 report.md 和至少一张中文 PNG 图表，报告使用相对图片链接。你自行选择分析方法，不安装依赖，不修改原文件。',
  },
  'J2-JOIN': {
    files: {
      'orders.csv': 'order_id,customer_id,amount\n1,A,100\n2,B,200\n3,C,50\n4,A,80\n',
      'customers.csv': 'customer_id,region\nA,北区\nA,北区\nB,南区\nD,西区\n',
    },
    task: '关联订单表与客户地区表，分析各地区订单金额分布并说明未匹配数据。金额单位为元。请自行检查并选择合理的数据处理方案，必要的假设请明确写入报告，不需要等待业务人员决定。生成 report.md 与中文 PNG 图表，并使用相对图片链接。不安装依赖，不修改原文件。',
  },
};
