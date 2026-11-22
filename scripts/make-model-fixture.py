import json, numpy as np, pandas as pd, statsmodels.api as sm
from statsmodels.duration.hazard_regression import PHReg
from scipy import stats
from lifelines.statistics import logrank_test
rng = np.random.default_rng(42); n = 400
age = np.round(rng.normal(62, 12, n), 1); sex = rng.integers(0, 2, n); treat = (rng.random(n) < 1/(1+np.exp(-(-0.5+0.03*(age-62)+0.4*sex)))).astype(int)
death = (rng.random(n) < 1/(1+np.exp(-(-2+0.04*(age-62)-0.7*treat+0.3*sex)))).astype(int)
cost = np.round(20000 + 300*(age-62) + 8000*treat + rng.normal(0, 6000, n), 2)
time = np.round(rng.exponential(1/np.exp(-3+0.02*(age-62)-0.5*treat)), 2) + 0.01; cens = np.round(rng.uniform(5, 60, n), 2)
event = (time <= cens).astype(int); time = np.minimum(time, cens)
w = np.round(rng.uniform(0.5, 2.0, n), 4)
X = sm.add_constant(np.column_stack([treat, age, sex]))
def t(res): return {"params": res.params.tolist(), "bse": res.bse.tolist(), "pvalues": res.pvalues.tolist()}
out = {"data": {"age": age.tolist(), "sex": sex.tolist(), "treat": treat.tolist(), "death": death.tolist(), "cost": cost.tolist(), "time": time.tolist(), "event": event.tolist(), "w": w.tolist()}}
out["logit"] = t(sm.Logit(death, X).fit(disp=0))
out["logit_w_hc0"] = t(sm.GLM(death, X, family=sm.families.Binomial(), var_weights=w).fit(cov_type="HC0"))
out["ols"] = t(sm.OLS(cost, X).fit())
out["wls_hc0"] = t(sm.WLS(cost, X, weights=w).fit(cov_type="HC0"))
ph = PHReg(time, np.column_stack([treat, age]), status=event, ties="breslow").fit()
out["cox"] = {"params": ph.params.tolist(), "bse": ph.bse.tolist(), "pvalues": ph.pvalues.tolist()}
wt = stats.ttest_ind(cost[treat==1], cost[treat==0], equal_var=False); out["welch"] = {"statistic": float(wt.statistic), "pvalue": float(wt.pvalue)}
lr = logrank_test(time[treat==1], time[treat==0], event[treat==1], event[treat==0]); out["logrank"] = {"chi2": float(lr.test_statistic), "p": float(lr.p_value)}
json.dump(out, open("/home/user/-InnovaHospital/test/fixtures/model-validation.json", "w"))
print(out["logit"]["params"], out["cox"]["params"], out["logrank"])
