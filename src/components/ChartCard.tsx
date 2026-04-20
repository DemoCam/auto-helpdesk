import React from 'react';
import ReactECharts from 'echarts-for-react';

interface ChartCardProps {
  title: string;
  options: any;
  id: string;
  height?: string;
  subtitle?: string;
}

const ChartCard: React.FC<ChartCardProps> = ({ title, options, id, height = '420px', subtitle }) => {
  return (
    <div className="chart-card" id={id}>
      <div className="chart-card-header">
        <h3>{title}</h3>
        {subtitle && <span className="chart-subtitle">{subtitle}</span>}
      </div>
      <div className="chart-container">
        <ReactECharts
          option={options}
          style={{ height, width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge={true}
        />
      </div>
    </div>
  );
};

export default ChartCard;
