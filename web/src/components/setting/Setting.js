import React, {Component} from 'react';
import {setThemePref, getThemePref} from "../../utils/theme";
import {Alert, Button, Form, Input, message, Select, Space, Switch, Tabs, Typography} from "antd";
import {LeftOutlined, RightOutlined} from "@ant-design/icons";
import request from "../../common/request";
import {download, getToken} from "../../utils/utils";
import {server} from "../../common/env";
import {isMobileNow, subscribeIsMobile} from "../../hook/use-breakpoint";

const {Option} = Select;
const {TabPane} = Tabs;
const {Title} = Typography;

const formItemLayout = {
    labelCol: {span: 12},
    wrapperCol: {span: 12},
};

const formTailLayout = {
    labelCol: {span: 12},
    wrapperCol: {span: 12},
};

const TAB_KEYS = ['rdp', 'telnet', 'vnc', 'guacd', 'mail', 'log', 'other', 'backup'];
const TAB_LABELS = ['RDP配置', 'TELNET配置', 'VNC配置', '录屏配置', '邮箱配置', '日志配置', '其他配置', '备份与恢复'];
class Setting extends Component {

    state = {
        isMobile: isMobileNow(),
        activeTab: 'rdp',
        refs: [],
        properties: {},
        ldapUserSyncLoading: false,
    }

    rdpSettingFormRef = React.createRef();
    sshSettingFormRef = React.createRef();
    vncSettingFormRef = React.createRef();
    guacdSettingFormRef = React.createRef();
    mailSettingFormRef = React.createRef();
    logSettingFormRef = React.createRef();
    otherSettingFormRef = React.createRef();

    componentWillUnmount() {
        if (this.unsubscribeBreakpoint) {
            this.unsubscribeBreakpoint();
            this.unsubscribeBreakpoint = null;
        }
    }

    componentDidMount() {
        // 订阅断点变化：旋屏时 Tab 栏需要从左侧切到顶部
        this.unsubscribeBreakpoint = subscribeIsMobile((isMobile) => {
            this.setState({isMobile});
        });

        // eslint-disable-next-line no-extend-native
        String.prototype.bool = function () {
            return (/^true$/i).test(this);
        };

        this.setState({
            refs: [
                this.rdpSettingFormRef,
                this.sshSettingFormRef,
                this.vncSettingFormRef,
                this.guacdSettingFormRef,
                this.mailSettingFormRef,
                this.logSettingFormRef,
                this.otherSettingFormRef
            ]
        }, this.getProperties)
    }

    changeProperties = async (values) => {
        let result = await request.put('/properties', values);
        if (result.code === 1) {
            message.success('修改成功');
        } else {
            message.error(result.message);
        }
    }

    getProperties = async () => {

        let result = await request.get('/properties');
        if (result['code'] === 1) {
            let properties = result['data'];

            for (let key in properties) {
                if (!properties.hasOwnProperty(key)) {
                    continue;
                }
                if (properties[key] === '-') {
                    properties[key] = '';
                }
                if (key.startsWith('enable') || key.startsWith("disable" || key === 'swap-red-blue')) {
                    properties[key] = properties[key].bool();
                }
            }

            this.setState({
                properties: properties
            })

            for (let ref of this.state.refs) {
                if (ref.current) {
                    ref.current.setFieldsValue(properties)
                }
            }
        } else {
            message.error(result['message']);
        }
    }

    handleOnTabChange = (key) => {
        this.getProperties();
    }
    handleImport = () => {
        let files = window.document.getElementById('file-upload').files;
        if (files.length === 0) {
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            let backup = JSON.parse(reader.result.toString());
            this.setState({
                importBtnLoading: true
            })
            try {
                let result = await request.post('/backup/import', backup);
                if (result['code'] === 1) {
                    message.success('恢复成功', 3);
                } else {
                    message.error(result['message'], 10);
                }
            } finally {
                this.setState({
                    importBtnLoading: false
                })
                window.document.getElementById('file-upload').value = "";
            }
        };
        reader.readAsText(files[0]);
    }

    ldapUserSync = async () => {
        const id = 'ldap-user-sync'
        try {
            this.setState({
                ldapUserSyncLoading: true
            });
            message.info({content: '同步中...', key: id, duration: 5});
            let result = await request.post(`/properties/ldap-user-sync`);
            if (result.code !== 1) {
                message.error({content: result.message, key: id, duration: 10});
                return;
            }
            message.success({content: '同步成功。', key: id, duration: 3});
        } finally {
            this.setState({
                ldapUserSyncLoading: false
            });
        }
    }

    render() {

        const tabIndex = TAB_KEYS.indexOf(this.state.activeTab);

        return (
            <div className="page-container-white">
                {this.state.isMobile && (
                    <div style={{display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12}}>
                        <Button
                            icon={<LeftOutlined/>}
                            disabled={tabIndex <= 0}
                            onClick={() => {
                                const prev = TAB_KEYS[tabIndex - 1];
                                this.setState({activeTab: prev});
                                this.handleOnTabChange(prev);
                            }}
                            style={{flex: '0 0 auto'}}
                        />
                        <Select
                            value={this.state.activeTab}
                            onChange={(key) => {
                                this.setState({activeTab: key});
                                this.handleOnTabChange(key);
                            }}
                            style={{flex: 1}}
                        >
                            {TAB_KEYS.map((k, i) => (
                                <Option key={k} value={k}>{TAB_LABELS[i]}</Option>
                            ))}
                        </Select>
                        <Button
                            icon={<RightOutlined/>}
                            disabled={tabIndex >= TAB_KEYS.length - 1}
                            onClick={() => {
                                const next = TAB_KEYS[tabIndex + 1];
                                this.setState({activeTab: next});
                                this.handleOnTabChange(next);
                            }}
                            style={{flex: '0 0 auto'}}
                        />
                    </div>
                )}
                <Tabs tabPosition={this.state.isMobile ? 'top' : 'left'}
                      activeKey={this.state.activeTab}
                      onChange={(key) => {
                          this.setState({activeTab: key});
                          this.handleOnTabChange(key);
                      }}
                      tabBarStyle={this.state.isMobile ? {display: 'none'} : {width: 150}}>
                    <TabPane tab="RDP配置" key="rdp">
                        <Form scrollToFirstError ref={this.rdpSettingFormRef} name="rdp" onFinish={this.changeProperties}
                              layout="vertical">

                            <Title level={4}>RDP配置(远程桌面)</Title>
                            <Form.Item
                                {...formItemLayout}
                                name="enable-wallpaper"
                                label="启用桌面墙纸"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="enable-theming"
                                label="启用桌面主题"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="enable-font-smoothing"
                                label="启用字体平滑（ClearType）"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                name="enable-full-window-drag"
                                label="启用全窗口拖拽"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                name="enable-desktop-composition"
                                label="启用桌面合成效果（Aero）"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                name="enable-menu-animations"
                                label="启用菜单动画"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                name="disable-bitmap-caching"
                                label="禁用位图缓存"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                name="disable-offscreen-caching"
                                label="禁用离屏缓存"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="TELNET配置" key="telnet">
                        <Form scrollToFirstError ref={this.sshSettingFormRef} name="ssh" onFinish={this.changeProperties}
                              layout="vertical">

                            <Title level={4}>TELNET配置</Title>

                            <Form.Item
                                {...formItemLayout}
                                name="color-scheme"
                                label="配色方案"
                                rules={[
                                    {
                                        required: true,
                                        message: '配色方案',
                                    },
                                ]}
                                initialValue="gray-black"
                            >
                                <Select style={{width: 120}} onChange={null}>
                                    <Option value="gray-black">黑底灰字</Option>
                                    <Option value="green-black">黑底绿字</Option>
                                    <Option value="white-black">黑底白字</Option>
                                    <Option value="black-white">白底黑字</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="font-name"
                                label="字体名称"
                                rules={[
                                    {
                                        required: true,
                                        message: '字体名称',
                                    },
                                ]}
                            >
                                <Input type='text' placeholder="请输入字体名称"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="font-size"
                                label="字体大小"
                                rules={[
                                    {
                                        required: true,
                                        message: '字体大小',
                                    },
                                ]}
                            >
                                <Input type='number' placeholder="请输入字体大小"/>
                            </Form.Item>

                            <Form.Item
                                name="backspace"
                                label="退格键映射"
                                {...formItemLayout}
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">默认</Option>
                                    <Option value="127">删除键(Ctrl-?)</Option>
                                    <Option value="8">退格键(Ctrl-H)</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                name="terminal-type"
                                label="终端类型"
                                {...formItemLayout}
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">默认</Option>
                                    <Option value="ansi">ansi</Option>
                                    <Option value="linux">linux</Option>
                                    <Option value="vt100">vt100</Option>
                                    <Option value="vt220">vt220</Option>
                                    <Option value="xterm">xterm</Option>
                                    <Option value="xterm-256color">xterm-256color</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="VNC配置" key="vnc">
                        <Form scrollToFirstError ref={this.vncSettingFormRef} name="vnc" onFinish={this.changeProperties}
                              layout="vertical">

                            <Title level={4}>VNC配置</Title>

                            <Form.Item
                                {...formItemLayout}
                                name="color-depth"
                                label="色彩深度"
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">默认</Option>
                                    <Option value="16">低色（16位）</Option>
                                    <Option value="24">真彩（24位）</Option>
                                    <Option value="32">真彩（32位）</Option>
                                    <Option value="8">256色</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="cursor"
                                label="光标"
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">默认</Option>
                                    <Option value="local">本地</Option>
                                    <Option value="remote">远程</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="swap-red-blue"
                                label="交换红蓝成分"
                                valuePropName="checked"
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                label='目标主机'
                                tooltip='连接到VNC代理（例如UltraVNC Repeater）时要请求的目标主机。'
                                name='dest-host'>
                                <Input placeholder="目标主机"/>
                            </Form.Item>
                            <Form.Item
                                {...formItemLayout}
                                label='目标端口'
                                tooltip='连接到VNC代理（例如UltraVNC Repeater）时要请求的目标端口。'
                                name='dest-port'>
                                <Input type='number' min={1} max={65535}
                                       placeholder='目标端口'/>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="录屏配置" key="guacd">
                        <Title level={4}>录屏配置</Title>
                        <Form scrollToFirstError ref={this.guacdSettingFormRef} name="guacd" onFinish={this.changeProperties}
                              layout="vertical">

                            <Form.Item
                                {...formItemLayout}
                                name="enable-recording"
                                label="开启录屏"
                                valuePropName="checked"
                                rules={[
                                    {
                                        required: true,
                                    },
                                ]}
                            >
                                <Switch checkedChildren="开启" unCheckedChildren="关闭" onChange={(checked) => {
                                    this.setState({
                                        properties: {
                                            ...this.state.properties,
                                            'enable-recording': checked,
                                        }
                                    })
                                }}/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="session-saved-limit"
                                label="会话录屏保存时长"
                                initialValue=""
                            >
                                <Select onChange={null} disabled={!this.state.properties['enable-recording']}>
                                    <Option value="">永久</Option>
                                    <Option value="30">30天</Option>
                                    <Option value="60">60天</Option>
                                    <Option value="180">180天</Option>
                                    <Option value="360">360天</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="邮箱配置" key="mail">
                        <Title level={4}>邮箱配置</Title>
                        <Alert
                            message="配置邮箱后，添加用户将向对方的邮箱发送账号密码。"
                            type="info"
                            style={{marginBottom: 10}}
                        />
                        <Form scrollToFirstError ref={this.mailSettingFormRef} name='mail' onFinish={this.changeProperties}
                              layout="vertical">

                            <Form.Item
                                {...formItemLayout}
                                name="mail-host"
                                label="邮件服务器地址"
                                rules={[
                                    {
                                        required: false,
                                        message: '邮件服务器地址',
                                    },
                                ]}
                            >
                                <Input type='text' placeholder="请输入邮件服务器地址"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="mail-port"
                                label="邮件服务器端口"
                                rules={[
                                    {
                                        required: false,
                                        message: '邮件服务器端口',
                                        min: 1,
                                        max: 65535
                                    },
                                ]}
                            >
                                <Input type='number' placeholder="请输入邮件服务器端口"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="mail-username"
                                label="邮箱账号"
                                rules={[
                                    {
                                        required: false,
                                        type: "email",
                                        message: '请输入正确的邮箱账号',
                                    },
                                ]}
                            >
                                <Input type='email' placeholder="请输入邮箱账号"/>
                            </Form.Item>
                            <input type='password' hidden={true} autoComplete='new-password'/>
                            <Form.Item
                                {...formItemLayout}
                                name="mail-password"
                                label="邮箱密码"
                                rules={[
                                    {
                                        required: false,
                                        message: '邮箱密码',
                                    },
                                ]}
                            >
                                <Input type='password' placeholder="请输入邮箱密码"/>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>

                    </TabPane>

                    <TabPane tab="日志配置" key="log">
                        <Title level={4}>日志配置</Title>
                        <Form scrollToFirstError ref={this.logSettingFormRef} name="log" onFinish={this.changeProperties}
                              layout="vertical">

                            <Form.Item
                                {...formItemLayout}
                                name="login-log-saved-limit"
                                label="登录日志保留时长"
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">永久</Option>
                                    <Option value="30">30天</Option>
                                    <Option value="60">60天</Option>
                                    <Option value="180">180天</Option>
                                    <Option value="360">360天</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="cron-log-saved-limit"
                                label="计划任务日志保留时长"
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">永久</Option>
                                    <Option value="30">30天</Option>
                                    <Option value="60">60天</Option>
                                    <Option value="180">180天</Option>
                                    <Option value="360">360天</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="storage-log-saved-limit"
                                label="存储日志保留时长"
                                initialValue=""
                            >
                                <Select onChange={null}>
                                    <Option value="">永久</Option>
                                    <Option value="30">30天</Option>
                                    <Option value="60">60天</Option>
                                    <Option value="180">180天</Option>
                                    <Option value="360">360天</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="其他配置" key="other">
                        <Title level={4}>其他配置</Title>
                        <Form scrollToFirstError ref={this.otherSettingFormRef} name="other" onFinish={this.changeProperties}
                              layout="vertical">

                            <Form.Item
                                {...formItemLayout}
                                name="user-default-storage-size"
                                label="用户空间默认大小"
                                tooltip='无限制请填写-1'
                            >
                                <Input type={'number'} min={-1} suffix="MB"/>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="keep-alive-ttl"
                                label="会话保持清理时长"
                                tooltip='启用「会话保持」的会话断开后，远端 tmux 会话保留多久再被自动清理（防止无人认领的进程泄漏）。-1 表示永久保留不清理'
                            >
                                <Select>
                                    <Option value="24">24小时（默认）</Option>
                                    <Option value="1">1小时</Option>
                                    <Option value="6">6小时</Option>
                                    <Option value="72">72小时</Option>
                                    <Option value="-1">永久保留</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item
                                {...formItemLayout}
                                name="appearance"
                                label="外观"
                                tooltip='iOS 标准：默认跟随系统外观（浅色/深色），可手动覆盖'
                            >
                                <Select
                                    defaultValue={getThemePref()}
                                    onChange={(v) => setThemePref(v)}
                                >
                                    <Option value="auto">跟随系统</Option>
                                    <Option value="light">浅色</Option>
                                    <Option value="dark">深色</Option>
                                </Select>
                            </Form.Item>

                            <Form.Item {...formTailLayout}>
                                <Button type="primary" htmlType="submit">
                                    更新
                                </Button>
                            </Form.Item>
                        </Form>
                    </TabPane>
                    <TabPane tab="备份与恢复" key="backup">
                        <Title level={4}>备份与恢复</Title>

                        <Space direction="vertical">
                            <Alert
                                message="恢复数据时，如存在登录账号相同的用户时，会保留原系统中的数据，此外由于登录密码加密之后不可逆，恢复的账户密码将随机产生。"
                                type="info"
                            />

                            <Space>
                                <Button type="primary" onClick={() => {
                                    download(`${server}/backup/export?X-Auth-Token=${getToken()}&t=${new Date().getTime()}`);
                                }}>
                                    导出备份
                                </Button>

                                <Button type="dashed" loading={this.state['importBtnLoading']} onClick={() => {
                                    window.document.getElementById('file-upload').click();
                                }}>
                                    恢复备份
                                </Button>
                                <input type="file" id="file-upload" style={{display: 'none'}}
                                       onChange={this.handleImport}/>
                            </Space>
                        </Space>

                    </TabPane>
                </Tabs>
            </div>
        );
    }
}

export default Setting;
