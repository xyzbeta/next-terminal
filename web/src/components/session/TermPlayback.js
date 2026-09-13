import React, {useEffect} from 'react';
import * as AsciinemaPlayer from 'asciinema-player';
import 'asciinema-player/dist/bundle/asciinema-player.css';
import {useSearchParams} from "react-router-dom";
import {server} from "../../common/env";
import {getToken} from "../../utils/utils";
import {useIsMobile} from "../../hook/use-breakpoint";
import BackButton from "../BackButton";

const TermPlayback = () => {

    const [searchParams] = useSearchParams();
    const sessionId = searchParams.get('sessionId');
    const isMobile = useIsMobile();

    useEffect(() => {
        let url = `${server}/sessions/${sessionId}/recording?X-Auth-Token=${getToken()}`;
        const container = document.getElementById('player');
        const player = AsciinemaPlayer.create(url, container, {
            cols: isMobile ? 100 : 144,
            rows: isMobile ? 30 : 32,
            // fit: 'width' scales the recording to the container width on mobile;
            // desktop keeps the fixed 144x32 grid
            fit: isMobile ? 'width' : false,
            terminalFontFamily: 'monaco, Consolas, "Lucida Console", monospace'
        });

        // 卸载 / 切换录制时释放播放器：dispose() 会卸载播放器组件树并清掉播放定时器与 DOM 监听。
        // 此前缺失该清理，离开页面后播放器实例与定时器残留（asciinema-player 3.x 的 create() 返回 dispose）
        return () => player.dispose();

        // isMobile 故意不加入依赖：横竖屏切换若重建播放器会丢失播放进度，体验倒退。
        // cols/rows/fit 在创建时按当时方向定型（fit: 'width' 已负责窄屏自适应宽度），
        // 旋转后无需重建，故此处显式豁免 exhaustive-deps 校验。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);

    return (
        <>
            <BackButton to="/#/offline-session"/>
            <div style={{
                width: '100vw',
                height: '100vh',
                backgroundColor: '#1b1b1b'
            }}>
                <div id='player'></div>
            </div>
        </>
    );
};

export default TermPlayback;