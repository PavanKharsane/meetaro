```groovy
pipeline {
    agent any

    environment {
        AWS_REGION = 'ap-south-1'
        ECR_REPOSITORY = '646966486222.dkr.ecr.ap-south-1.amazonaws.com/meetaro'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm ci'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npm test'
            }
        }

        stage('Build Docker Image') {
            steps {
                script {
                    env.IMAGE_TAG = "${BUILD_NUMBER}"
                }
                sh 'docker build -t $ECR_REPOSITORY:$IMAGE_TAG .'
            }
        }

        stage('Login to Amazon ECR') {
            steps {
                sh '''
                    aws ecr get-login-password --region "$AWS_REGION" |
                    docker login --username AWS --password-stdin "$ECR_REPOSITORY"
                '''
            }
        }

        stage('Push Image to ECR') {
            steps {
                sh 'docker push $ECR_REPOSITORY:$IMAGE_TAG'
            }
        }
    }

    post {
        success {
            echo 'Meetaro CI/CD pipeline completed successfully.'
        }
        failure {
            echo 'Meetaro CI/CD pipeline failed. Check the stage logs.'
        }
    }
}
```
