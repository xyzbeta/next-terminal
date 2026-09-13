import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Button, Drawer, Empty, Input, message, Select, Spin} from "antd";
import {FilterOutlined, ReloadOutlined, SearchOutlined} from "@ant-design/icons";

/**
 * 移动端列表原语。
 *
 * 为什么需要它：桌面端的列表是「一整块查询表单 + 一张多列表格 + 一行工具栏」。
 * 这套东西在手机上完全不成立——实测在线会话页的查询表单独占 390×844 屏幕的 44%，
 * 表格横排后只能看到前 4 列、其余要横向滑动，工具栏还额外占一行。
 * 用户看到的是「一个被塞进手机里的后台」。
 *
 * 手机上的既定范式是：
 *   · 一行搜索框（常驻，占位符说明可搜什么）+ 一个「筛选」按钮
 *   · 筛选条件收进底部抽屉，不占首屏
 *   · 数据以卡片呈现，每张卡 2~3 条关键信息 + 行内操作
 *   · 滚动到底自动加载下一页（不必点分页器）
 *
 * 本组件承担上述全部结构，各页面只需提供「怎么取数」和「卡片长什么样」。
 * 桌面端不受影响——各页面在 isMobile 分支里用它，桌面仍走 ProTable。
 */

const PAGE_SIZE = 20;

const MobileList = ({
    title,
    searchPlaceholder = '搜索',
    filters = [],                 // [{name, label, options:[{label,value}], value}]
    request,                      // async ({pageIndex, pageSize, keyword, filters}) => {items, total}
    renderCard,
    rowKey = 'id',
    emptyText = '暂无数据',
    headerExtra,                  // 标题行右侧的额外操作（如「新建」）
    onFilterChange,
}) => {
    const [keyword, setKeyword] = useState('');
    const [filterValues, setFilterValues] = useState(() => {
        const init = {};
        filters.forEach((f) => {
            init[f.name] = f.value;
        });
        return init;
    });
    const [filterOpen, setFilterOpen] = useState(false);
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [pageIndex, setPageIndex] = useState(1);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [errMsg, setErrMsg] = useState('');

    // 用于丢弃过期响应：搜索框每次输入都会发起请求，
    // 先发的后到会把新结果覆盖成旧结果（经典的竞态）
    const seqRef = useRef(0);
    const sentinelRef = useRef(null);

    const fetchPage = useCallback(async (page, append) => {
        const seq = ++seqRef.current;
        if (append) {
            setLoadingMore(true);
        } else {
            setLoading(true);
        }
        try {
            const res = await request({pageIndex: page, pageSize: PAGE_SIZE, keyword, filters: filterValues});
            if (seq !== seqRef.current) {
                return; // 已有更新的请求，丢弃本次结果
            }
            const list = res.items || [];
            setItems((prev) => (append ? prev.concat(list) : list));
            setTotal(Number(res.total || 0));
            setErrMsg('');
        } catch (e) {
            if (seq === seqRef.current) {
                // 与列表页的统一约定一致：失败必须显式可见，
                // 不能渲染成「暂无数据」让用户误判为没有记录
                setErrMsg('加载失败，请检查网络后重试');
                if (!append) {
                    setItems([]);
                }
            }
        } finally {
            if (seq === seqRef.current) {
                setLoading(false);
                setLoadingMore(false);
            }
        }
    }, [request, keyword, filterValues]);

    // 搜索防抖：每输入一个字都请求既浪费移动流量，也会让列表频繁跳动
    useEffect(() => {
        const t = setTimeout(() => {
            setPageIndex(1);
            fetchPage(1, false);
        }, 300);
        return () => clearTimeout(t);
    }, [fetchPage]);

    // 触底加载：手机上不适合点分页器，滚动到底继续加载才符合习惯
    useEffect(() => {
        const node = sentinelRef.current;
        if (!node || typeof IntersectionObserver === 'undefined') {
            return;
        }
        const io = new IntersectionObserver((entries) => {
            if (!entries[0].isIntersecting) {
                return;
            }
            if (loading || loadingMore) {
                return;
            }
            setPageIndex((prev) => {
                if (prev * PAGE_SIZE >= total) {
                    return prev;
                }
                const next = prev + 1;
                fetchPage(next, true);
                return next;
            });
        }, {rootMargin: '120px'});
        io.observe(node);
        return () => io.disconnect();
    }, [loading, loadingMore, total, fetchPage]);

    const activeFilterCount = filters.filter(
        (f) => filterValues[f.name] !== undefined && filterValues[f.name] !== '' && filterValues[f.name] !== null
    ).length;

    const applyFilter = (name, value) => {
        const next = {...filterValues, [name]: value};
        setFilterValues(next);
        if (onFilterChange) {
            onFilterChange(next);
        }
    };

    const resetFilters = () => {
        const next = {};
        filters.forEach((f) => {
            next[f.name] = undefined;
        });
        setFilterValues(next);
        if (onFilterChange) {
            onFilterChange(next);
        }
    };

    return (
        <div className="ml">
            {/* 一行搜索 + 筛选：替代桌面端整块查询表单 */}
            <div className="ml-searchbar">
                <Input
                    allowClear
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    placeholder={searchPlaceholder}
                    prefix={<SearchOutlined style={{color: '#bfbfbf'}}/>}
                    className="ml-search"
                />
                {filters.length > 0 && (
                    <Button
                        className="ml-filter-btn"
                        icon={<FilterOutlined/>}
                        onClick={() => setFilterOpen(true)}
                    >
                        筛选{activeFilterCount > 0 ? `(${activeFilterCount})` : ''}
                    </Button>
                )}
                <Button
                    className="ml-filter-btn"
                    icon={<ReloadOutlined/>}
                    aria-label="刷新"
                    onClick={() => {
                        setPageIndex(1);
                        fetchPage(1, false);
                    }}
                />
            </div>

            <div className="ml-header">
                <span className="ml-title">{title}</span>
                <span className="ml-count">{total > 0 ? `${total} 条` : ''}</span>
                <span className="ml-header-extra">{headerExtra}</span>
            </div>

            {errMsg && (
                <div className="ml-error">
                    {errMsg}
                    <Button type="link" size="small" onClick={() => fetchPage(1, false)}>重试</Button>
                </div>
            )}

            {loading && items.length === 0 ? (
                <div className="ml-loading"><Spin/></div>
            ) : items.length === 0 && !errMsg ? (
                <Empty description={emptyText} style={{marginTop: 48}}/>
            ) : (
                <div className="ml-cards">
                    {items.map((item) => (
                        <div className="ml-card" key={item[rowKey]}>
                            {renderCard(item)}
                        </div>
                    ))}
                </div>
            )}

            {/* 触底哨兵 + 状态提示 */}
            <div ref={sentinelRef} className="ml-sentinel">
                {loadingMore && <Spin size="small"/>}
                {!loadingMore && items.length > 0 && items.length >= total && (
                    <span className="ml-end">— 已加载全部 {total} 条 —</span>
                )}
            </div>

            {/* 筛选抽屉：从底部升起，符合手机操作习惯，且不占首屏 */}
            <Drawer
                placement="bottom"
                height="auto"
                closable={false}
                visible={filterOpen}
                onClose={() => setFilterOpen(false)}
                bodyStyle={{paddingBottom: 'calc(16px + var(--safe-bottom, 0px))'}}
            >
                <div className="ml-filter-title">筛选条件</div>
                {filters.map((f) => (
                    <div className="ml-filter-item" key={f.name}>
                        <div className="ml-filter-label">{f.label}</div>
                        <Select
                            allowClear
                            style={{width: '100%'}}
                            placeholder={`请选择${f.label}`}
                            value={filterValues[f.name]}
                            onChange={(v) => applyFilter(f.name, v)}
                            options={f.options}
                        />
                    </div>
                ))}
                <div className="ml-filter-actions">
                    <Button block onClick={resetFilters}>重置</Button>
                    <Button block type="primary" onClick={() => setFilterOpen(false)}>完成</Button>
                </div>
            </Drawer>
        </div>
    );
};

export {PAGE_SIZE};
export default MobileList;
