#!/bin/bash
# View PM2 logs from production server
# Usage: ./logs-prod.sh

EC2_HOST="13.204.61.199"
EC2_USER="ec2-user"
SSH_KEY="/Users/devarshukani/Work/Keys/apex/my-ec2-key"
PM2_APP="stocker-backend-node"

ssh -i $SSH_KEY ${EC2_USER}@${EC2_HOST} "pm2 logs ${PM2_APP} --lines 100"
