/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { validate as validateEmail } from 'deep-email-validator';
import { MetaService } from '@/core/MetaService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type Logger from '@/logger.js';
import type { UserProfilesRepository } from '@/models/_.js';
import { LoggerService } from '@/core/LoggerService.js';
import { bindThis } from '@/decorators.js';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

@Injectable()
export class EmailService {
	private logger: Logger;
	private client: SESClient;
	private dynamoDb: DynamoDBClient;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		private metaService: MetaService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('email');
		this.client = new SESClient();
		this.dynamoDb = new DynamoDBClient();
	}

	@bindThis
	public async sendEmail(to: string, subject: string, html: string, text: string) {
		const meta = await this.metaService.fetch(true);

		const iconUrl = `${this.config.url}/static-assets/mi-white.png`;
		const emailSettingUrl = `${this.config.url}/settings/email`;
		
		const checkRes = await this.checkEmailBounce(to);
		if (checkRes) {
			this.logger.error("Email address " + to + " is registered on bounce table.");
			throw new Error("Email address " + to + " is registered on bounce table.");
		}



		try {
			// TODO: htmlサニタイズ
			const htmlData: string = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8">
		<title>${ subject }</title>
		<style>
			html {
				background: #eee;
			}

			body {
				padding: 16px;
				margin: 0;
				font-family: sans-serif;
				font-size: 14px;
			}

			a {
				text-decoration: none;
				color: #86b300;
			}
			a:hover {
				text-decoration: underline;
			}

			main {
				max-width: 500px;
				margin: 0 auto;
				background: #fff;
				color: #555;
			}
				main > header {
					padding: 32px;
					background: #86b300;
				}
					main > header > img {
						max-width: 128px;
						max-height: 28px;
						vertical-align: bottom;
					}
				main > article {
					padding: 32px;
				}
					main > article > h1 {
						margin: 0 0 1em 0;
					}
				main > footer {
					padding: 32px;
					border-top: solid 1px #eee;
				}

			nav {
				box-sizing: border-box;
				max-width: 500px;
				margin: 16px auto 0 auto;
				padding: 0 32px;
			}
				nav > a {
					color: #888;
				}
		</style>
	</head>
	<body>
		<main>
			<header>
				<img src="${ meta.logoImageUrl ?? meta.iconUrl ?? iconUrl }"/>
			</header>
			<article>
				<h1>${ subject }</h1>
				<div>${ html }</div>
			</article>
			<footer>
				<a href="${ emailSettingUrl }">${ 'Email setting' }</a>
			</footer>
		</main>
		<nav>
			<a href="${ this.config.url }">${ this.config.host }</a>
		</nav>
	</body>
</html>`;
			const command = new SendEmailCommand({
				Source: meta.email!,
				Destination: {
					ToAddresses: [to]
				},
				Message: {
					Subject: {
						Data: subject,
						Charset: "UTF-8"
					},
					Body: {
						Text: {
							Data: text,
							Charset: "UTF-8"
						},
						Html: {
							Data: htmlData,
							Charset: "UTF-8"
						}
					}
				}
			});
			const sesRes = await this.client.send(command);

			this.logger.info(`Message sent: ${sesRes.MessageId}`);
		} catch (err) {
			this.logger.error(err as Error);
			throw err;
		}
	}

	@bindThis
	public async validateEmailForAccount(emailAddress: string): Promise<{
		available: boolean;
		reason: null | 'used' | 'format' | 'disposable' | 'mx' | 'smtp';
	}> {
		const meta = await this.metaService.fetch();

		const exist = await this.userProfilesRepository.countBy({
			emailVerified: true,
			email: emailAddress,
		});
		
		const checkBounce = await this.checkEmailBounce(emailAddress);

		const validated = meta.enableActiveEmailValidation ? await validateEmail({
			email: emailAddress,
			validateRegex: true,
			validateMx: true,
			validateTypo: false, // TLDを見ているみたいだけどclubとか弾かれるので
			validateDisposable: true, // 捨てアドかどうかチェック
			validateSMTP: false, // 日本だと25ポートが殆どのプロバイダーで塞がれていてタイムアウトになるので
		}) : { valid: true, reason: null };

		const available = exist === 0 && validated.valid && !checkBounce;

		return {
			available,
			reason: available ? null :
			exist !== 0 ? 'used' :
			checkBounce ? 'smtp' :
			validated.reason === 'regex' ? 'format' :
			validated.reason === 'disposable' ? 'disposable' :
			validated.reason === 'mx' ? 'mx' :
			validated.reason === 'smtp' ? 'smtp' :
			null,
		};
	}
	
	@bindThis
	private async checkEmailBounce(emailAddress: string): Promise<boolean> {
		const tableName = process.env.BOUNCE_TABLE_NAME;
		if (!tableName) {
			return false;
		}
		const getItemCmd = new GetItemCommand({
			TableName: tableName,
			Key: {
				"email": {"S": emailAddress},
				"category": {"S": "Bounce_Info"}
			}
		});
		const getItemRes = await this.dynamoDb.send(getItemCmd);
		if (!getItemRes.Item) {
			return false;
		}
		const endTime = Math.floor(Date.now() / 1000) + 86400 * 7;
		const updateItemCmd = new UpdateItemCommand({
			TableName: tableName,
			Key: {
				"email": {"S": emailAddress},
				"category": {"S": "Bounce_Info"}
			},
			UpdateExpression: "SET #TL = :tl",
			ExpressionAttributeNames: {
				"#TL": "ttl"
			},
			ExpressionAttributeValues: {
				":tl": {"N": endTime.toString()}
			}
		});
		await this.dynamoDb.send(updateItemCmd);
		return true;
	}
}
