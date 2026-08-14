package cron

import "github.com/robfig/cron/v3"

var GlobalCron *cron.Cron

type Job cron.Job

func init() {
	// SkipIfStillRunning：任务执行超过一个调度周期时不叠加执行，防止资源尖峰与连接数翻倍
	GlobalCron = cron.New(cron.WithSeconds(), cron.WithChain(cron.SkipIfStillRunning(cron.DefaultLogger)))
	GlobalCron.Start()
}

func JobId(jobId int) cron.EntryID {
	return cron.EntryID(jobId)
}
