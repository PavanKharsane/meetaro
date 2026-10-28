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

        stage('SonarQube Analysis') {
            steps {
                script {
                    def scannerHome = tool 'SonarScanner'
                    withSonarQubeEnv('Meetaro-SonarQube') {
                        sh """
                            ${scannerHome}/bin/sonar-scanner \
                            -Dsonar.projectKey=meetaro \
                            -Dsonar.projectName=Meetaro \
                            -Dsonar.sources=. \
                            -Dsonar.exclusions=node_modules/**,coverage/**,.git/**,**/*.test.js,**/*.spec.js
                        """
                    }
                }
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
                    docker login --username AWS --password-stdin "646966486222.dkr.ecr.ap-south-1.amazonaws.com"
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

