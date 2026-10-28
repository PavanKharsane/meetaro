output "ecr_repository_name" {
  description = "Name of the Meetaro ECR repository"
  value       = aws_ecr_repository.meetaro.name
}

output "ecr_repository_url" {
  description = "URL of the Meetaro ECR repository"
  value       = aws_ecr_repository.meetaro.repository_url
}
