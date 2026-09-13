import React, {useEffect, useRef, useState} from 'react';
import {useSearchParams} from "react-router-dom";
import {server} from "../../common/env";
import {getToken} from "../../utils/utils";
import Guacamole from "guacamole-common-js";
import {PauseCircleOutlined, PlayCircleOutlined} from "@ant-design/icons";
import {Button, Col, message, Row, Select, Slider} from "antd";
import times from "../../utils/times";
import {debounce} from "../../utils/fun";
import BackButton from "../BackButton";

const GuacdPlayback = () => {

    const [searchParams] = useSearchParams();
    const sessionId = searchParams.get('sessionId');

    // 会话录制对象与倍速 setTimeout 链的句柄。
    // 此前 recording 是模块级 let（多实例共享）、timer 是函数体内的 let（每次渲染重新声明绑定，
    // clearTimeout 读到的是新绑定，倍速链停不下来）。改用 ref：跨渲染稳定且实例隔离。
    const recordingRef = useRef(null);
    const timerRef = useRef(null);

    let [playBtnIcon, setPlayBtnIcon] = useState(<PlayCircleOutlined/>);
    let [position, setPosition] = useState('00:00');
    let [duration, setDuration] = useState('00:00');
    let [percent, setPercent] = useState(0);
    let [max, setMax] = useState(0);
    let [speed, setSpeed] = useState(1.0);

    let [waiting, setWaiting] = useState(true);

    useEffect(() => {
        recordingRef.current = init(sessionId);
        const recording = recordingRef.current;

        let _resize = () => {
            // debounce 是尾沿触发且无 cancel，卸载后仍可能有一次挂起的调用；
            // 此时 recordingRef 已被 cleanup 置空，必须判空（否则 onWindowResize 抛 TypeError）
            if (recordingRef.current) {
                onWindowResize(recordingRef.current);
            }
        }

        let resize = debounce(_resize);
        recording.getDisplay().onresize = _resize;
        window.addEventListener('resize', resize);

        return () => {
            // 停掉倍速递增的 setTimeout 链，否则卸载后仍会继续 seek（此前完全没有清理）
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (recording) {
                recording.disconnect();
                const displayEl = recording.getDisplay().getElement();
                displayEl.innerHTML = '';
                if (displayEl.parentElement) {
                    displayEl.parentElement.onclick = null;
                }
            }
            recordingRef.current = null;
            window.removeEventListener('resize', resize);
        }
    }, [sessionId]);

    const onTunnelStateChange = (state) => {
        switch (state) {
            case Guacamole.Tunnel.State.OPEN:
                handlePlayPause();
                break;
            case Guacamole.Tunnel.State.CLOSED:
                break;
            default:
                break;
        }
    };

    const init = (sessionId) => {
        const RECORDING_URL = `${server}/sessions/${sessionId}/recording?X-Auth-Token=${getToken()}`;

        const tunnel = new Guacamole.StaticHTTPTunnel(RECORDING_URL);
        tunnel.onstatechange = onTunnelStateChange;
        const recording = new Guacamole.SessionRecording(tunnel);

        const recordingDisplay = recording.getDisplay();

        const display = document.getElementById('display');
        display.appendChild(recordingDisplay.getElement());
        recording.connect();

        // If playing, the play/pause button should read "Pause"
        recording.onplay = () => {
            setPlayBtnIcon(<PauseCircleOutlined/>);
        };

        // If paused, the play/pause button should read "Play"
        recording.onpause = () => {
            setPlayBtnIcon(<PlayCircleOutlined/>);
        };

        // Toggle play/pause when display or button are clicked
        display.onclick = () => {
            handlePlayPause();
        };

        // Fit display within containing div
        recordingDisplay.onresize = function displayResized(width, height) {

            // Do not scale if display has no width
            if (!width)
                return;

            // Scale display to fit width of container
            recordingDisplay.scale(display.offsetWidth / width);
        };

        recording.onseek = (millis) => {
            setPercent(millis);
            setPosition(times.formatTime(millis));
        };

        recording.onprogress = (millis) => {
            setMax(millis);
            setDuration(times.formatTime(millis));
        };

        return recording;
    }

    const onWindowResize = (recording) => {
        let width = recording.getDisplay().getWidth();
        let height = recording.getDisplay().getHeight();

        let winWidth = window.innerWidth;
        let winHeight = window.innerHeight - 40;

        let scaleW = winWidth / width;
        let scaleH = winHeight / height;

        let scale = Math.min(scaleW, scaleH);
        if (!scale) {
            return;
        }
        recording.getDisplay().scale(scale);
    };

    const startSpeedUp = () => {
        stopSpeedUp();
        const recording = recordingRef.current;
        if (speed === 1) {
            return;
        }
        if (!recording || !recording.isPlaying()) {
            return;
        }
        const add_time = 100;
        let delay = 1000 / (1000 / add_time) / (speed - 1);

        let max = recording.getDuration();
        let current = recording.getPosition();
        if (current >= max) {
            return;
        }
        recording.seek(current + add_time, () => {
            timerRef.current = setTimeout(startSpeedUp, delay);
        });
    }

    const stopSpeedUp = () => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }

    const handlePlayPause = () => {
        const recording = recordingRef.current;
        if (!recording) {
            return;
        }
        if (percent === max) {
            // 重播
            setPercent(0);
            recording.seek(0, () => {
                recording.play();
                startSpeedUp();
            });
        }

        if (!recording.isPlaying()) {
            recording.play();
            startSpeedUp();
        } else {
            recording.pause();
            stopSpeedUp();
            message.info('暂停');
        }
    }

    const handleProgressChange = (value) => {
        // Request seek
        if (!recordingRef.current) {
            return;
        }
        recordingRef.current.seek(value, () => {
        });
    }

    return (
        <>
            <BackButton to="/#/offline-session"/>
            <div style={{
                width: '100vw',
                height: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: '#1b1b1b'
            }}>
                <div id="player">
                    <div id="display">
                        <div className="notification-container">
                            <div className="seek-notification">
                            </div>
                        </div>
                    </div>

                    {waiting ?

                        <div style={{color: 'white', fontWeight: 'bold', cursor: 'pointer'}} onClick={() => {
                            setWaiting(false);
                            handlePlayPause();
                        }}>点击播放</div>
                        :
                        <Row justify="space-around" align="middle" style={{margin: 4}}
                             gutter={[5, 5]}>
                            <Col flex="none">
                                <Button size='small' onClick={handlePlayPause} icon={playBtnIcon}/>
                            </Col>
                            <Col flex="auto">
                                <Slider value={percent} max={max} tooltipVisible={false} onChange={handleProgressChange}/>
                            </Col>
                            <Col flex='none'>
                                <Select size={'small'} defaultValue='1' value={speed} onChange={(value) => {
                                    setSpeed(value);
                                    if (value === 1) {
                                        stopSpeedUp();
                                    } else {
                                        startSpeedUp();
                                    }
                                }}>
                                    <Select.Option key="1" value={1.0}>1.0倍速</Select.Option>
                                    <Select.Option key="1.25" value={1.25}>1.25倍速</Select.Option>
                                    <Select.Option key="1.5" value={1.5}>1.5倍速</Select.Option>
                                    <Select.Option key="1.75" value={1.75}>1.75倍速</Select.Option>
                                    <Select.Option key="2.0" value={2.0}>2.0倍速</Select.Option>
                                </Select>
                            </Col>
                            <Col flex='none'>
                                <div style={{color: 'white'}}>
                                    <b>{position}</b>/ <b>{duration}</b>
                                </div>
                            </Col>
                        </Row>
                    }


                </div>
            </div>
        </>
    );
};

export default GuacdPlayback;