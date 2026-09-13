import React, {Component} from 'react';
import {DesktopOutlined, DisconnectOutlined, LoginOutlined, UserOutlined} from '@ant-design/icons';
import request from "../../common/request";
import './Dashboard.css'
import {ProCard, StatisticCard} from '@ant-design/pro-components';
// 按需引入：@ant-design/charts 的入口会连带 @ant-design/graphs/maps/flowchart（G6/L7），
// 且这些包为 CJS 无法 tree-shake，会把整个 g2plot 打进 chunk；@ant-design/plots 为 ESM 可按需引入。
import {Line, Pie} from '@ant-design/plots';
import {Segmented} from 'antd';

// 本文件是控制面板的**桌面实现**，由 Dashboard.js 通过 React.lazy 按需加载。
// 拆分的唯一理由是包体：本模块静态引入 @ant-design/plots，实测构建出 872KB 的图表 chunk
// （gzip 约 250KB）。移动端概览页不用任何图表库（见 DashboardMobile.js），
// 若两者同处一个模块，手机访问 /dashboard 仍要下载这 872KB。
// 拆分后移动端分支永不触发该 import，图表 chunk 不进入移动端的下载队列。
//
// ⚠️ 本文件是原 Dashboard.js 的原样搬迁，渲染结果与拆分前逐字节一致；
//    修改界面请同时确认 DashboardMobile.js 是否需要同步（两套实现有意分离，不共享组件）。
class DashboardDesktop extends Component {

    state = {
        counter: {
            onlineUser: 0,
            totalUser: 0,
            activeAsset: 0,
            totalAsset: 0,
            failLoginCount: 0,
            offlineSession: 0,
        },
        asset: {
            "ssh": 0,
            "rdp": 0,
            "vnc": 0,
            "telnet": 0,
            "kubernetes": 0,
        },
        dateCounter: [],
    }

    componentDidMount() {
        this.getCounter();
        this.getAsset();
        this.getDateCounter('week');
    }

    componentWillUnmount() {

    }

    getCounter = async () => {
        let result = await request.get('/overview/counter');
        if (result['code'] === 1) {
            this.setState({
                counter: result['data']
            })
        }
    }

    getDateCounter = async (d) => {
        let result = await request.get('/overview/date-counter?d=' + d);
        if (result['code'] === 1) {
            this.setState({
                dateCounter: result['data']
            })
        }
    }

    getAsset = async () => {
        let result = await request.get('/overview/asset');
        if (result['code'] === 1) {
            this.setState({
                asset: result['data']
            })
        }
    }

    handleChangeDateCounter = (value) => {
        if(value === '按周'){
            this.getDateCounter('week');
        }else {
            this.getDateCounter('month');
        }
    }

    render() {

        const assetData = [
            {
                type: 'RDP',
                value: this.state.asset['rdp'],
            },
            {
                type: 'SSH',
                value: this.state.asset['ssh'],
            },
            {
                type: 'TELNET',
                value: this.state.asset['telnet'],
            },
            {
                type: 'VNC',
                value: this.state.asset['vnc'],
            },
            {
                type: 'Kubernetes',
                value: this.state.asset['kubernetes'],
            }
        ];
        const assetConfig = {
            width: 200,
            height: 200,
            appendPadding: 10,
            data: assetData,
            angleField: 'value',
            colorField: 'type',
            radius: 1,
            innerRadius: 0.6,
            label: {
                type: 'inner',
                offset: '-50%',
                content: '{value}',
                style: {
                    textAlign: 'center',
                    fontSize: 14,
                },
            },
            interactions: [{type: 'element-selected'}, {type: 'element-active'}],
            statistic: {
                title: false,
                content: {
                    formatter: () => {
                        return '资产类型';
                    },
                    style: {
                        fontSize: 18,
                    }
                },
            },
        };

        const dateCounterConfig = {
            height: 270,
            data: this.state.dateCounter,
            xField: 'date',
            yField: 'value',
            seriesField: 'type',
            legend: {
                position: 'top',
            },
            smooth: true,
            animation: {
                appear: {
                    animation: 'path-in',
                    duration: 5000,
                },
            },
        };

        return (<>
            <div style={{margin: 16}}>
                <ProCard
                    title="数据概览"
                    // extra={dayjs().format("YYYY[年]MM[月]DD[日]") + ' 星期' + weekMapping[dayjs().day()]}
                    split={'horizontal'}
                    headerBordered
                    bordered
                >
                    <ProCard split={'vertical'}>
                        <ProCard split="horizontal">
                            <ProCard split='vertical'>
                                <StatisticCard
                                    statistic={{
                                        title: '在线用户',
                                        value: this.state.counter['onlineUser'] + '/' + this.state.counter['totalUser'],
                                        prefix: <UserOutlined/>
                                    }}
                                />
                                <StatisticCard
                                    statistic={{
                                        title: '运行中资产',
                                        value: this.state.counter['activeAsset'] + '/' + this.state.counter['totalAsset'],
                                        prefix: <DesktopOutlined/>
                                    }}
                                />
                            </ProCard>
                            <ProCard split='vertical'>
                                <StatisticCard
                                    statistic={{
                                        title: '登录失败次数',
                                        value: this.state.counter['failLoginCount'],
                                        prefix: <LoginOutlined/>
                                    }}
                                />
                                <StatisticCard
                                    statistic={{
                                        title: '历史会话总数',
                                        value: this.state.counter['offlineSession'],
                                        prefix: <DisconnectOutlined/>
                                    }}
                                />
                            </ProCard>
                        </ProCard>
                        <ProCard className='pie-card'>
                            <ProCard>
                                <Pie {...assetConfig} />
                            </ProCard>
                        </ProCard>
                    </ProCard>

                </ProCard>

                <ProCard title="会话统计" style={{marginTop: 16}}
                         extra={<Segmented options={['按周', '按月']} onChange={this.handleChangeDateCounter}/>}>
                    <Line {...dateCounterConfig} />
                </ProCard>
            </div>
        </>);
    }
}

export default DashboardDesktop;
