import { IsString, IsUrl, IsOptional, IsArray, IsIn } from 'class-validator';

export class CreateApiDto {
  @IsString()
  apiName: string;

  @IsUrl()
  openApiUrl: string;

  @IsOptional()
  @IsString()
  type: string = 'openapi';

  @IsOptional()
  @IsString()
  @IsIn(['5m', '15m', '1h', '6h', '1d'])
  checkFrequency: string = '1h';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  description?: string;
}
