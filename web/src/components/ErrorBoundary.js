import React from 'react';
import {Button, Result, Typography} from "antd";

const {Paragraph, Text} = Typography;

/**
 * 渲染错误边界。
 *
 * 为什么必须有：React 18 中任何一个组件在渲染期抛错，若没有错误边界，
 * 整棵树会被卸载 —— 用户看到的是**纯白页面**，连一个「重新加载」的入口都没有。
 * 对运维长会话场景尤其致命：终端页可能已经连上，用户在切到某个列表页时
 * 因一条脏数据（如非法日期）触发渲染异常，整个应用连同进行中的会话一起消失，
 * 且无从判断是网络问题还是前端问题。
 *
 * 用 class 组件实现是 React 的硬性要求：目前只有 class 支持
 * componentDidCatch / getDerivedStateFromError。
 */
class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = {hasError: false, error: null};
    }

    static getDerivedStateFromError(error) {
        return {hasError: true, error};
    }

    componentDidCatch(error, errorInfo) {
        // 保留完整堆栈到控制台：生产环境的 sourcemap 不再随镜像发布，
        // 控制台输出是排查的第一手材料
        console.error('[ErrorBoundary] 组件渲染异常', error, errorInfo);
    }

    handleReload = () => {
        window.location.reload();
    };

    handleReset = () => {
        // 仅重置边界状态，尝试重新渲染子树（局部故障时无需整页刷新）
        this.setState({hasError: false, error: null});
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const tip = this.props.tip || '页面渲染出现异常';

        return (
            <Result
                status="error"
                title={tip}
                subTitle="该问题不影响已建立的后台连接，可尝试重新渲染或刷新页面。"
                extra={[
                    <Button type="primary" key="reload" onClick={this.handleReload}>
                        重新加载页面
                    </Button>,
                    <Button key="retry" onClick={this.handleReset}>
                        尝试恢复
                    </Button>,
                ]}
            >
                <Paragraph>
                    <Text strong>错误信息：</Text>
                </Paragraph>
                <Paragraph>
                    <Text code style={{wordBreak: 'break-all'}}>
                        {this.state.error && this.state.error.toString()}
                    </Text>
                </Paragraph>
                <Paragraph type="secondary" style={{marginBottom: 0}}>
                    若反复出现，请把上面的错误信息与操作路径提供给管理员。
                </Paragraph>
            </Result>
        );
    }
}

export default ErrorBoundary;
