resource "aws_ecr_repository" "meetaro" {
  name                 = "meetaro"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Name        = "meetaro"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_vpc" "meetaro" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "meetaro-vpc"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_internet_gateway" "meetaro" {
  vpc_id = aws_vpc.meetaro.id

  tags = {
    Name        = "meetaro-igw"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_subnet" "public_a" {
  vpc_id                  = aws_vpc.meetaro.id
  cidr_block              = "10.20.1.0/24"
  availability_zone       = "ap-south-1a"
  map_public_ip_on_launch = true

  tags = {
    Name        = "meetaro-public-subnet-a"
    Tier        = "public"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_subnet" "public_b" {
  vpc_id                  = aws_vpc.meetaro.id
  cidr_block              = "10.20.2.0/24"
  availability_zone       = "ap-south-1b"
  map_public_ip_on_launch = true

  tags = {
    Name        = "meetaro-public-subnet-b"
    Tier        = "public"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.meetaro.id
  cidr_block        = "10.20.11.0/24"
  availability_zone = "ap-south-1a"

  tags = {
    Name        = "meetaro-private-subnet-a"
    Tier        = "private"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.meetaro.id
  cidr_block        = "10.20.12.0/24"
  availability_zone = "ap-south-1b"

  tags = {
    Name        = "meetaro-private-subnet-b"
    Tier        = "private"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.meetaro.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.meetaro.id
  }

  tags = {
    Name        = "meetaro-public-rt"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_route_table_association" "public_a" {
  subnet_id      = aws_subnet.public_a.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.meetaro.id

  tags = {
    Name        = "meetaro-private-rt"
    Environment = "dev"
    ManagedBy   = "Terraform"
    Project     = "Meetaro"
  }
}

resource "aws_route_table_association" "private_a" {
  subnet_id      = aws_subnet.private_a.id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "private_b" {
  subnet_id      = aws_subnet.private_b.id
  route_table_id = aws_route_table.private.id
}
