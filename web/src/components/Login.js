import React, {useEffect, useState} from 'react';
import {Button, Card, Checkbox, Form, Input, message, Modal, Typography} from "antd";
import './Login.css'
import request from "../common/request";
import {LockOutlined, UserOutlined} from '@ant-design/icons';
import {setToken} from "../utils/utils";
import brandingApi from "../api/branding";
import strings from "../utils/strings";
import {useNavigate} from "react-router-dom";
import {setCurrentUser} from "../service/permission";
import queryClient from "../service/query-client";
import PromptModal from "../dd/prompt-modal/prompt-modal";

const {Title, Text} = Typography;

const LoginForm = () => {

    const navigate = useNavigate();

    let [inLogin, setInLogin] = useState(false);
    let [branding, setBranding] = useState({});
    let [prompt, setPrompt] = useState(false);
    let [account, setAccount] = useState({});

    useEffect(() => {
        const x = async () => {
            let branding = await brandingApi.getBranding();
            document.title = branding['name'];
            setBranding(branding);
        }
        x();
    }, []);

    const afterLoginSuccess = async (data) => {
        // 跳转登录
        sessionStorage.removeItem('current');
        sessionStorage.removeItem('openKeys');
        setToken(data['token']);

        // 清空所有 react-query 缓存。
        //
        // 必须在这里清，而不是只在「退出登录」时清：进入登录页的路径不止一条
        // （主动退出、会话过期被 401 踢回、双因素认证中断），漏掉任何一条都会让
        // 上一个账号的用户信息/资产/会话数据留在内存缓存里，被下一个登录的账号
        // 直接读出来（staleTime 5 分钟内不会重新请求）——既是显示错误，也是数据泄露。
        queryClient.clear();

        let user = data['info'];
        setCurrentUser(user);
        if (user) {
            if (user['type'] === 'user') {
                navigate('/my-asset');
            } else {
                navigate('/');
            }
        }
    }

    const login = async (values) => {
        let result = await request.post('/login', values);
        if (result['code'] === 1) {
            Modal.destroyAll();
            await afterLoginSuccess(result['data']);
        }
    }

    const handleOk = (loginAccount, totp) => {
        if (!strings.hasText(totp)) {
            message.warn("请输入双因素认证码");
            return false;
        }
        loginAccount['totp'] = totp;
        login(loginAccount);
        return false;
    }

    const handleSubmit = async params => {
        setInLogin(true);

        try {
            let result = await request.post('/login', params);
            if (result.code === 100) {
                // 进行双因素认证
                setPrompt(true);
                setAccount(params);
                return;
            }
            if (result.code !== 1) {
                return;
            }

            afterLoginSuccess(result['data']);
        } catch (e) {
            message.error(e.message);
        } finally {
            setInLogin(false);
        }
    };

    return (
        <div className='login-page' style={{width: '100vw', height: '100vh', backgroundColor: '#fafafa'}}>
            <Card className='login-card' title={null}>
                <div style={{textAlign: "center", margin: '15px auto 30px auto', color: '#1890ff'}}>
                    <Title level={1}>{branding['name']}</Title>
                    <Text>{branding['description']}</Text>
                </div>
                <Form scrollToFirstError onFinish={handleSubmit} className="login-form">
                    <Form.Item name='username' rules={[{required: true, message: '请输入登录账号！'}]}>
                        <Input prefix={<UserOutlined/>} placeholder="登录账号"/>
                    </Form.Item>
                    <Form.Item name='password' rules={[{required: true, message: '请输入登录密码！'}]}>
                        <Input.Password prefix={<LockOutlined/>} placeholder="登录密码"/>
                    </Form.Item>
                    <Form.Item name='remember' valuePropName='checked' initialValue={false}>
                        <Checkbox>保持登录</Checkbox>
                    </Form.Item>
                    <Form.Item>
                        <Button type="primary" htmlType="submit" className="login-form-button"
                                loading={inLogin}>
                            登录
                        </Button>
                    </Form.Item>
                </Form>
            </Card>

            <PromptModal
                title={'双因素认证'}
                open={prompt}
                onOk={(value) => {
                    handleOk(account, value)
                }}
                onCancel={() => setPrompt(false)}
                placeholder={"请输入双因素认证码"}
            >

            </PromptModal>
        </div>

    );
}

export default LoginForm;
