# Phase A follow-up (same logs, nothing re-run)

## 1. Troops, three ways (against the old lattice, 54 paired seeds)

  s025: 54 games, 1130 nations alive under both settings
    mean of log troops                -5.53% [-17.75,+8.51]  margin +-5%  inconclusive
    median troops (log ratio)        -12.06% [-32.63,+14.81]  margin +-5%  inconclusive
    paired same-nation ratio (log)    -4.20% [-17.09,+10.69]  margin +-5%  inconclusive
  s050: 54 games, 1159 nations alive under both settings
    mean of log troops                -4.44% [-14.34,+6.59]  margin +-5%  inconclusive
    median troops (log ratio)        -11.14% [-27.78,+9.35]  margin +-5%  inconclusive
    paired same-nation ratio (log)    -7.52% [-16.51,+2.44]  margin +-5%  inconclusive
  s075: 54 games, 1143 nations alive under both settings
    mean of log troops                -4.16% [-16.12,+9.51]  margin +-5%  inconclusive
    median troops (log ratio)         -8.34% [-27.08,+15.22]  margin +-5%  inconclusive
    paired same-nation ratio (log)    -7.06% [-19.37,+7.13]  margin +-5%  inconclusive

## 2. Warships: dose response

  legacy: 167.5 warships per game (54 games)
  s025:   182.2    +8.8% [-2.4,+19.9]  margin +-10%  inconclusive
  s050:   189.8   +13.3% [+1.6,+25.0]  margin +-10%  inconclusive
  s075:   176.1    +5.1% [-6.3,+16.6]  margin +-10%  inconclusive
  per-game slope of warships/legacy-mean against s: -0.073 per unit s [-0.192,+0.046]
  the three means: +8.8%, +13.3%, +5.1%
  mix050A (half the nations jittered):   176.5    +5.4% [-4.3,+15.1]
  mix050B (half the nations jittered):   165.0    -1.5% [-9.8,+6.8]

  s050 minus legacy, warships per game, by map:
    real:africa        +53.5 per game  (6 games)
    real:asia          +33.3 per game  (6 games)
    real:balkans       -17.7 per game  (6 games)
    real:baltics       +32.3 per game  (6 games)
    real:britannia     -21.8 per game  (6 games)
    real:caribbean     +73.2 per game  (6 games)
    real:eastasia      +16.0 per game  (6 games)
    real:europe        +23.2 per game  (6 games)
    world               +9.2 per game  (6 games)
  nations alive at the end, legacy vs s050: 24.4 vs 24.4
  warships per game against nations alive (s050): correlation +0.48
  five games with the largest warship swing (legacy -> s050):
    caribbean-rich-n34-s12          529 ->    834
    europe-rich-n26-s11             234 ->    430
    world-rich-n31-s11              326 ->    487
    africa-rich-n44-s12             387 ->    538
    baltics-rich-n35-s12            429 ->    567

## 3. How many comparisons did phase A make

  strength 5 metrics x 3 spreads = 15; action types 16 (incl. ALL) x 3 = 48; mixed games 3: 66 in the first report
  follow-up: troops 3 methods x 3 spreads = 9 (re-analysis of 3 of them), warships 3 + 2 mixed + 1 slope
  at 95%, about 3.3 of 66 intervals exclude zero by chance alone; the first report had 2 (warships s050, emoji s050)
  Bonferroni threshold: p < 0.0008 per comparison
  warships s050 vs legacy paired t-test p = 0.026
