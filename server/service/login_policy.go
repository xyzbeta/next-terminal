package service

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"

	"next-terminal/server/model"
	"next-terminal/server/repository"
	"next-terminal/server/utils"
)

var LoginPolicyService = new(loginPolicyService)

type loginPolicyService struct {
	baseService
}

func (s loginPolicyService) Create(c context.Context, m *model.LoginPolicy) error {
	return s.Transaction(c, func(ctx context.Context) error {
		if err := repository.LoginPolicyRepository.Create(ctx, m); err != nil {
			return err
		}

		if len(m.TimePeriod) > 0 {
			for i := range m.TimePeriod {
				m.TimePeriod[i].ID = utils.UUID()
				m.TimePeriod[i].LoginPolicyId = m.ID
			}
			if err := repository.TimePeriodRepository.CreateInBatches(ctx, m.TimePeriod); err != nil {
				return err
			}
		}

		return nil
	})
}

func (s loginPolicyService) DeleteByIds(ctx context.Context, ids []string) error {
	return s.Transaction(ctx, func(ctx context.Context) error {
		for _, id := range ids {
			if err := repository.LoginPolicyRepository.DeleteById(ctx, id); err != nil {
				return err
			}
			if err := repository.LoginPolicyUserRefRepository.DeleteByLoginPolicyId(ctx, id); err != nil {
				return err
			}
			if err := repository.TimePeriodRepository.DeleteByLoginPolicyId(ctx, id); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s loginPolicyService) UpdateById(ctx context.Context, m *model.LoginPolicy, id string) error {
	return s.Transaction(ctx, func(ctx context.Context) error {
		if err := repository.LoginPolicyRepository.UpdateById(ctx, m, id); err != nil {
			return err
		}
		if err := repository.TimePeriodRepository.DeleteByLoginPolicyId(ctx, id); err != nil {
			return err
		}
		if len(m.TimePeriod) > 0 {
			for i := range m.TimePeriod {
				m.TimePeriod[i].ID = utils.UUID()
				m.TimePeriod[i].LoginPolicyId = m.ID
			}
			if err := repository.TimePeriodRepository.CreateInBatches(ctx, m.TimePeriod); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s loginPolicyService) FindById(ctx context.Context, id string) (*model.LoginPolicy, error) {
	policy, err := repository.LoginPolicyRepository.FindById(ctx, id)
	if err != nil {
		return nil, err
	}
	timePeriods, err := repository.TimePeriodRepository.FindByLoginPolicyId(ctx, id)
	if err != nil {
		return nil, err
	}
	policy.TimePeriod = timePeriods

	return &policy, nil
}

func (s loginPolicyService) Check(userId, clientIp string) error {
	ctx := context.Background()
	// 按照优先级倒排进行查询
	policies, err := repository.LoginPolicyRepository.FindByUserId(ctx, userId)
	if err != nil {
		return err
	}
	if len(policies) == 0 {
		return nil
	}

	if err := s.checkClientIp(policies, clientIp); err != nil {
		return err
	}

	if err := s.checkWeekDay(policies); err != nil {
		return err
	}
	return nil
}

func (s loginPolicyService) checkClientIp(policies []model.LoginPolicy, clientIp string) error {
	// 多策略匹配时，取优先级最高（Priority 最小）的策略的规则
	var bestMatch *model.LoginPolicy
	for _, policy := range policies {
		if !policy.Enabled {
			continue
		}
		ipGroups := strings.Split(policy.IpGroup, ",")
		for _, group := range ipGroups {
			matched := false
			if strings.Contains(group, "/") {
				_, ipNet, err := net.ParseCIDR(group)
				if err != nil {
					continue
				}
				matched = ipNet.Contains(net.ParseIP(clientIp))
			} else if strings.Contains(group, "-") {
				split := strings.Split(group, "-")
				if len(split) < 2 {
					continue
				}
				intReqIP := utils.IpToInt(clientIp)
				matched = intReqIP >= utils.IpToInt(split[0]) && intReqIP <= utils.IpToInt(split[1])
			} else {
				matched = group == clientIp
			}
			if matched {
				if bestMatch == nil || policy.Priority < bestMatch.Priority {
					bestMatch = &policy
				}
				break
			}
		}
	}

	if bestMatch == nil {
		// 无策略匹配，默认允许
		return nil
	}
	if bestMatch.Rule != "allow" {
		return errors.New("非常抱歉，您当前使用的IP地址不允许进行登录。")
	}
	return nil
}

func (s loginPolicyService) checkWeekDay(policies []model.LoginPolicy) error {
	now := time.Now()
	weekday := int(now.Weekday())
	hwc := now.Format("15:04")

	// 多策略匹配时，取优先级最高（Priority 最小）的策略的规则
	var bestMatch *model.LoginPolicy
	for _, policy := range policies {
		if !policy.Enabled {
			continue
		}
		timePeriods, err := repository.TimePeriodRepository.FindByLoginPolicyId(context.Background(), policy.ID)
		if err != nil {
			return err
		}

		matched := false
		for _, period := range timePeriods {
			if weekday != period.Key {
				continue
			}
			if period.Value == "" {
				continue
			}
			times := strings.Split(period.Value, "、")
			for _, t := range times {
				timeRange := strings.Split(t, "~")
				start := timeRange[0]
				end := timeRange[1]
				if (start == "00:00" && end == "00:00") || (start <= hwc && hwc <= end) {
					matched = true
					break
				}
			}
			if matched {
				break
			}
		}
		if matched {
			if bestMatch == nil || policy.Priority < bestMatch.Priority {
				bestMatch = &policy
			}
		}
	}

	if bestMatch == nil {
		return nil
	}
	if bestMatch.Rule != "allow" {
		return errors.New("非常抱歉，当前时段不允许您进行登录。")
	}
	return nil
}
func (s loginPolicyService) Bind(ctx context.Context, loginPolicyId string, items []model.LoginPolicyUserRef) error {
	return s.Transaction(ctx, func(ctx context.Context) error {
		var results []model.LoginPolicyUserRef
		for i := range items {
			if items[i].UserId == "" {
				continue
			}
			exist, err := repository.UserRepository.ExistById(ctx, items[i].UserId)
			if err != nil {
				continue
			}
			if !exist {
				continue
			}
			refId := utils.Sign([]string{items[i].UserId, loginPolicyId})
			if err := repository.LoginPolicyUserRefRepository.DeleteId(ctx, refId); err != nil {
				return err
			}
			results = append(results, model.LoginPolicyUserRef{
				ID:            refId,
				UserId:        items[i].UserId,
				LoginPolicyId: loginPolicyId,
			})
		}
		if len(results) == 0 {
			return nil
		}

		return repository.LoginPolicyUserRefRepository.CreateInBatches(ctx, results)
	})
}

func (s loginPolicyService) Unbind(ctx context.Context, loginPolicyId string, items []model.LoginPolicyUserRef) error {
	return s.Transaction(ctx, func(ctx context.Context) error {
		for i := range items {
			if items[i].UserId == "" {
				continue
			}
			if err := repository.LoginPolicyUserRefRepository.DeleteByLoginPolicyIdAndUserId(ctx, loginPolicyId, items[i].UserId); err != nil {
				return err
			}
		}
		return nil
	})
}
