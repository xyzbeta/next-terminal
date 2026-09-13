import React from 'react';
import ReactDOM from 'react-dom';
import {MemoryRouter} from 'react-router-dom';
import {ConfigProvider} from 'antd';
import zhCN from 'antd/lib/locale-provider/zh_CN';
import {QueryClient, QueryClientProvider} from 'react-query';
import App from './App';

it('renders without crashing', () => {
  const div = document.createElement('div');
  const queryClient = new QueryClient();
  ReactDOM.render(
      <ConfigProvider locale={zhCN}>
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </MemoryRouter>
      </ConfigProvider>, div);
  ReactDOM.unmountComponentAtNode(div);
});
