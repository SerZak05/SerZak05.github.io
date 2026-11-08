---
layout: contest
title: "Smoke contest 2"
contest_id: "smoke-contest-2"
---

# Easy–Medium–Hard Contest

Three machine learning tasks ordered by increasing difficulty: tabular churn classification, LLM preference prediction, and low-light object detection.

## 1. Customer Churn Prediction

**Source:** [Customer Churn Prediction](https://www.kaggle.com/competitions/udel-customer-churn-prediction)

**Datasets:**

- [udel-churn-submission-sample.csv](https://www.kaggle.com/competitions/udel-customer-churn-prediction/data?select=udel-churn-submission-sample.csv)
- [udel-churn-test.csv](https://www.kaggle.com/competitions/udel-customer-churn-prediction/data?select=udel-churn-test.csv)
- [udel-churn-train.csv](https://www.kaggle.com/competitions/udel-customer-churn-prediction/data?select=udel-churn-train.csv)

Predict whether each customer has left within the last month (`Churn`: Yes or No) from historical service, account, and demographic features. Evaluation is accuracy.

## 2. LLM Classification Finetuning

**Source:** [LLM Classification Finetuning](https://www.kaggle.com/competitions/llm-classification-finetuning)

**Datasets:**

- [sample_submission.csv](https://www.kaggle.com/competitions/llm-classification-finetuning/data?select=sample_submission.csv)
- [test.csv](https://www.kaggle.com/competitions/llm-classification-finetuning/data?select=test.csv)
- [train.csv](https://www.kaggle.com/competitions/llm-classification-finetuning/data?select=train.csv)

From Chatbot Arena pairwise interactions, predict the probability that a judge prefers model A, prefers model B, or ties, given a shared prompt and the two model responses. Submissions are scored with log loss.

## 3. 🌙 The 3LC Low-Light Detection Challenge

**Source:** [🌙 The 3LC Low-Light Detection Challenge](https://www.kaggle.com/competitions/the-3lc-low-light-detection-challenge)

**Datasets:**

- [data](https://www.kaggle.com/competitions/the-3lc-low-light-detection-challenge/data)
- [setup](https://www.kaggle.com/competitions/the-3lc-low-light-detection-challenge/overview/setup)

Detect 12 object classes in low-light photographs using axis-aligned YOLO bounding boxes (normalized center, width, and height). Evaluation is mean average precision at IoU 0.5 (mAP@0.5) on a held-out test set.
